package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	caddycmd "github.com/caddyserver/caddy/v2/cmd"
	_ "github.com/caddyserver/caddy/v2/modules/standard"
	proxy "github.com/lucaslorentz/caddy-docker-proxy/v2"
	_ "github.com/tailscale/caddy-tailscale"
	"golang.org/x/crypto/hkdf"
)

const stateDir = "/state"
const reportPort = 8080

var hostnamePattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$`)
var sitePattern = regexp.MustCompile(`(?ms)^http://([a-z0-9.-]+):8080\s*\{([^}]*)\}`)

type identity struct {
	NodeID            string `json:"nodeId"`
	MachineName       string `json:"machineName"`
	Role              string `json:"role"`
	Worker            string `json:"worker"`
	SigningPrivateKey string `json:"signingPrivateKey"`
}
type exposure struct {
	Hostname string `json:"hostname"`
	Port     int    `json:"port"`
}
type encryptedKey struct {
	NodeID             string `json:"nodeId"`
	MachineName        string `json:"machineName"`
	Role               string `json:"role"`
	EphemeralPublicKey string `json:"ephemeralPublicKey"`
	Nonce              string `json:"nonce"`
	Ciphertext         string `json:"ciphertext"`
}

func encode(b []byte) string          { return base64.RawURLEncoding.EncodeToString(b) }
func decode(s string) ([]byte, error) { return base64.RawURLEncoding.DecodeString(s) }

func request(worker, path string, body any, id *identity) ([]byte, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequest(http.MethodPost, worker+"/api/nodes/"+path, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if id != nil {
		key, err := decode(id.SigningPrivateKey)
		if err != nil {
			return nil, err
		}
		stamp := strconv.FormatInt(time.Now().UnixMilli(), 10)
		req.Header.Set("X-Node-ID", id.NodeID)
		req.Header.Set("X-Node-Timestamp", stamp)
		req.Header.Set("X-Node-Signature", encode(ed25519.Sign(ed25519.PrivateKey(key), []byte(stamp+"\n"+string(raw)))))
	}
	client := &http.Client{Timeout: 20 * time.Second}
	response, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 65536))
	if err != nil {
		return nil, err
	}
	if response.StatusCode/100 != 2 {
		return nil, fmt.Errorf("Worker %s: HTTP %d: %s", path, response.StatusCode, string(data))
	}
	return data, nil
}
func decryptKey(result encryptedKey, private *ecdh.PrivateKey) (string, error) {
	peerBytes, err := decode(result.EphemeralPublicKey)
	if err != nil {
		return "", err
	}
	peer, err := ecdh.X25519().NewPublicKey(peerBytes)
	if err != nil {
		return "", err
	}
	shared, err := private.ECDH(peer)
	if err != nil {
		return "", err
	}
	reader := hkdf.New(sha256.New, shared, make([]byte, 32), []byte("tailscale-cloudflare-node-v1"))
	key := make([]byte, 32)
	if _, err := io.ReadFull(reader, key); err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce, err := decode(result.Nonce)
	if err != nil {
		return "", err
	}
	encrypted, err := decode(result.Ciphertext)
	if err != nil {
		return "", err
	}
	plain, err := gcm.Open(nil, nonce, encrypted, nil)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}
func writePrivate(path string, data []byte) error {
	temp := path + ".tmp"
	if err := os.WriteFile(temp, data, 0600); err != nil {
		return err
	}
	return os.Rename(temp, path)
}
func enroll(role, worker string) (*identity, string, error) {
	code, err := os.ReadFile("/run/enroll/code")
	if err != nil {
		return nil, "", fmt.Errorf("read enrollment code: %w", err)
	}
	_, signing, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, "", err
	}
	exchange, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, "", err
	}
	body := map[string]string{"code": strings.TrimSpace(string(code)), "signingPublicKey": encode(signing.Public().(ed25519.PublicKey)), "exchangePublicKey": encode(exchange.PublicKey().Bytes())}
	raw, err := request(worker, "enroll", body, nil)
	if err != nil {
		return nil, "", err
	}
	var result encryptedKey
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, "", err
	}
	if result.Role != role {
		return nil, "", errors.New("enrollment code role does not match installer mode")
	}
	key, err := decryptKey(result, exchange)
	if err != nil {
		return nil, "", err
	}
	id := &identity{NodeID: result.NodeID, MachineName: result.MachineName, Role: role, Worker: worker, SigningPrivateKey: encode(signing)}
	idRaw, _ := json.Marshal(id)
	if err := writePrivate(filepath.Join(stateDir, "identity.json"), idRaw); err != nil {
		return nil, "", err
	}
	if err := writePrivate(filepath.Join(stateDir, "pending-auth"), []byte(key)); err != nil {
		return nil, "", err
	}
	_ = os.Remove("/run/enroll/code")
	return id, key, nil
}
func loadIdentity(role, worker string) (*identity, string, error) {
	if err := os.MkdirAll(stateDir, 0700); err != nil {
		return nil, "", err
	}
	raw, err := os.ReadFile(filepath.Join(stateDir, "identity.json"))
	if errors.Is(err, os.ErrNotExist) {
		return enroll(role, worker)
	}
	if err != nil {
		return nil, "", err
	}
	var id identity
	if err := json.Unmarshal(raw, &id); err != nil {
		return nil, "", err
	}
	if id.Role != role || id.Worker != worker {
		return nil, "", errors.New("saved identity belongs to a different mode or Worker")
	}
	pending, err := os.ReadFile(filepath.Join(stateDir, "pending-auth"))
	if errors.Is(err, os.ErrNotExist) {
		return &id, "unused", nil
	}
	if err != nil {
		return nil, "", err
	}
	return &id, string(pending), nil
}
func parseExposures(caddyfile []byte) []exposure {
	unique := map[string]bool{}
	for _, match := range sitePattern.FindAllSubmatch(caddyfile, -1) {
		host, body := string(match[1]), string(match[2])
		if !hostnamePattern.MatchString(host) || !strings.Contains(body, "bind tailscale/router") {
			continue
		}
		for _, line := range strings.Split(body, "\n") {
			fields := strings.Fields(line)
			if len(fields) > 1 && fields[0] == "reverse_proxy" {
				unique[host] = true
			}
		}
	}
	result := make([]exposure, 0, len(unique))
	for host := range unique {
		result = append(result, exposure{Hostname: host, Port: reportPort})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Hostname < result[j].Hostname })
	return result
}
func reporter(id *identity, updates <-chan []exposure) {
	current := []exposure{}
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case next := <-updates:
			current = next
		case <-ticker.C:
		}
		if _, err := request(id.Worker, "report", map[string]any{"exposures": current}, id); err != nil {
			log.Printf("report failed: %v", err)
		}
	}
}

func clearPendingAuth() {
	if err := os.Remove(filepath.Join(stateDir, "pending-auth")); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Printf("remove consumed auth key: %v", err)
	}
}

func clearGatewayAuthWhenReady() {
	client := &http.Client{Timeout: 2 * time.Second}
	for attempt := 0; attempt < 90; attempt++ {
		response, err := client.Get("http://127.0.0.1:2019/config/")
		if err == nil {
			_ = response.Body.Close()
			if response.StatusCode == http.StatusOK {
				clearPendingAuth()
				return
			}
		}
		time.Sleep(2 * time.Second)
	}
}
func main() {
	if len(os.Args) < 2 || os.Args[1] != "node" {
		caddycmd.Main()
		return
	}
	if len(os.Args) != 3 {
		log.Fatal("usage: caddy node gateway|router")
	}
	role := os.Args[2]
	if role != "gateway" && role != "router" {
		log.Fatal("invalid role")
	}
	worker := strings.TrimSuffix(os.Getenv("WORKER_URL"), "/")
	if !strings.HasPrefix(worker, "https://") {
		log.Fatal("WORKER_URL must use HTTPS")
	}
	if role == "gateway" && os.Getenv("ACME_EMAIL") == "" {
		log.Fatal("ACME_EMAIL is required")
	}
	id, key, err := loadIdentity(role, worker)
	if err != nil {
		log.Fatal(err)
	}
	os.Setenv("TS_HOSTNAME", id.MachineName)
	os.Setenv("TS_AUTHKEY", key)
	updates := make(chan []exposure, 1)
	if role == "router" {
		var mu sync.Mutex
		proxy.OnConfigApplied = func(config []byte) {
			clearPendingAuth()
			routes := parseExposures(config)
			mu.Lock()
			defer mu.Unlock()
			select {
			case <-updates:
			default:
			}
			updates <- routes
		}
	}
	if role == "gateway" {
		go clearGatewayAuthWhenReady()
	}
	go reporter(id, updates)
	if role == "gateway" {
		os.Args = []string{"caddy", "run", "--config", "/etc/caddy/gateway.Caddyfile", "--adapter", "caddyfile"}
	}
	if role == "router" {
		os.Args = []string{"caddy", "docker-proxy", "--mode", "standalone", "--caddyfile-path", "/etc/caddy/router.Caddyfile", "--ingress-networks", os.Getenv("INGRESS_NETWORK")}
	}
	caddycmd.Main()
}
