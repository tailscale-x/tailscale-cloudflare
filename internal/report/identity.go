package report

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

type identityFile struct {
	Public  string `json:"public"`
	Private string `json:"private"`
}

func LoadOrCreate(path string) (ed25519.PublicKey, ed25519.PrivateKey, error) {
	if b, err := os.ReadFile(path); err == nil {
		var f identityFile
		if json.Unmarshal(b, &f) == nil {
			pub, pubErr := base64.RawStdEncoding.DecodeString(f.Public)
			priv, privErr := base64.RawStdEncoding.DecodeString(f.Private)
			if pubErr == nil && privErr == nil && len(pub) == ed25519.PublicKeySize && len(priv) == ed25519.PrivateKeySize {
				return ed25519.PublicKey(pub), ed25519.PrivateKey(priv), nil
			}
		}
		return nil, nil, errors.New("invalid report identity file")
	} else if !os.IsNotExist(err) {
		return nil, nil, err
	}
	pub, priv, err := GenerateKey()
	if err != nil {
		return nil, nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, nil, err
	}
	b, _ := json.Marshal(identityFile{Public: base64.RawStdEncoding.EncodeToString(pub), Private: base64.RawStdEncoding.EncodeToString(priv)})
	if err := os.WriteFile(path, b, 0600); err != nil {
		return nil, nil, err
	}
	return pub, priv, nil
}
