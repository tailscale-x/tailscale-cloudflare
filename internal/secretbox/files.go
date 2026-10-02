package secretbox

import (
	"errors"
	"os"
)

var errNotExist = os.ErrNotExist
var osReadFile = os.ReadFile
var osWriteFile = func(path string, b []byte) error { return os.WriteFile(path, b, 0600) }

var _ = errors.Is
