package main

import (
	"reflect"
	"testing"
)

func TestParseExposures(t *testing.T) {
	generated := []byte(`{
 tailscale {
  router {
   hostname router
  }
 }
}
:9080 {
 bind tailscale/router
 respond 200
}
http://one.example.com:8080 {
 bind tailscale/router
 reverse_proxy 172.30.0.2:3000
}
http://two.example.com:8080 {
 bind tailscale/router
 reverse_proxy 172.30.0.3:4000
}
http://unreachable.example.com:8080 {
 bind tailscale/router
 reverse_proxy
}
http://public.example.com:8080 {
 reverse_proxy 172.30.0.4:5000
}
`)
	want := []exposure{{"one.example.com", 8080}, {"two.example.com", 8080}}
	if got := parseExposures(generated); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}
