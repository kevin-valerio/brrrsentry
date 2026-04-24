package e2ebug

import (
	"encoding/json"
	"errors"
)

func DecodeEvent(data []byte) (Event, error) {
	var raw any
	if err := json.Unmarshal(data, &raw); err != nil {
		return Event{}, err
	}

	obj, ok := raw.(map[string]any)
	if !ok {
		return Event{}, errors.New("expected JSON object")
	}

	// BUG: type assertion without validation (panics when payload is missing or not an object).
	payload := obj["payload"].(map[string]any)

	kind, _ := obj["type"].(string)
	return Event{Type: kind, Payload: payload}, nil
}
