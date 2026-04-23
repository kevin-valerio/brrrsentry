package grammarjson

import (
	"encoding/json"
	"errors"
)

func Parse(data []byte) (string, error) {
	var v any
	if err := json.Unmarshal(data, &v); err != nil {
		return "", err
	}

	s, ok := v.(string)
	if !ok {
		return "", errors.New("expected JSON string")
	}

	// BUG: deliberate crash for grammar fuzzing.
	if s == "abba" {
		panic("boom")
	}

	return s, nil
}
