package secretbox

import "testing"

func TestSealRoundTrip(t *testing.T) {
	key := []byte("01234567890123456789012345678901")
	ciphertext, err := Seal(key, "oauth-secret")
	if err != nil {
		t.Fatal(err)
	}
	plaintext, err := OpenValue(key, ciphertext)
	if err != nil {
		t.Fatal(err)
	}
	if plaintext != "oauth-secret" {
		t.Fatalf("got %q", plaintext)
	}
}

func TestOpenValueRejectsWrongKey(t *testing.T) {
	key := []byte("01234567890123456789012345678901")
	ciphertext, err := Seal(key, "secret")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := OpenValue([]byte("abcdefghijklmnopqrstuvwxyz123456"), ciphertext); err == nil {
		t.Fatal("expected authentication failure")
	}
}
