package report

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

type Envelope struct {
	NodeID    string          `json:"node_id"`
	Timestamp int64           `json:"timestamp"`
	Nonce     string          `json:"nonce"`
	PublicKey string          `json:"public_key"`
	Payload   json.RawMessage `json:"payload"`
	Signature string          `json:"signature"`
}

func GenerateKey() (ed25519.PublicKey, ed25519.PrivateKey, error) {
	return ed25519.GenerateKey(rand.Reader)
}

func NewEnvelope(nodeID string, payload any, publicKey ed25519.PublicKey, privateKey ed25519.PrivateKey, now time.Time) (Envelope, error) {
	b, err := json.Marshal(payload)
	if err != nil {
		return Envelope{}, err
	}
	if nodeID == "" || len(publicKey) != ed25519.PublicKeySize || len(privateKey) != ed25519.PrivateKeySize {
		return Envelope{}, errors.New("invalid signing identity")
	}
	nonceBytes := make([]byte, 16)
	if _, err := rand.Read(nonceBytes); err != nil {
		return Envelope{}, err
	}
	e := Envelope{NodeID: nodeID, Timestamp: now.Unix(), Nonce: base64.RawURLEncoding.EncodeToString(nonceBytes), PublicKey: base64.RawStdEncoding.EncodeToString(publicKey), Payload: b}
	e.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, signingBytes(e)))
	return e, nil
}

func Verify(e Envelope, now time.Time, maxAge time.Duration) (map[string]any, ed25519.PublicKey, error) {
	if e.NodeID == "" || e.Nonce == "" || e.Timestamp <= 0 || len(e.Payload) == 0 {
		return nil, nil, errors.New("incomplete report envelope")
	}
	if maxAge <= 0 {
		maxAge = 5 * time.Minute
	}
	age := now.Sub(time.Unix(e.Timestamp, 0))
	if age < -maxAge || age > maxAge {
		return nil, nil, errors.New("report timestamp outside acceptance window")
	}
	pub, err := base64.RawStdEncoding.DecodeString(e.PublicKey)
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return nil, nil, errors.New("invalid report public key")
	}
	sig, err := base64.StdEncoding.DecodeString(e.Signature)
	if err != nil || len(sig) != ed25519.SignatureSize || !ed25519.Verify(pub, signingBytes(e), sig) {
		return nil, nil, errors.New("invalid report signature")
	}
	var payload map[string]any
	if err := json.Unmarshal(e.Payload, &payload); err != nil {
		return nil, nil, fmt.Errorf("invalid report payload: %w", err)
	}
	return payload, pub, nil
}

func signingBytes(e Envelope) []byte {
	return []byte(fmt.Sprintf("%s\n%d\n%s\n%s", e.NodeID, e.Timestamp, e.Nonce, e.Payload))
}
