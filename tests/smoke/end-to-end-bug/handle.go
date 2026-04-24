package e2ebug

import "errors"

func HandleEvent(data []byte) ([]byte, error) {
	event, err := DecodeEvent(data)
	if err != nil {
		return nil, err
	}

	switch event.Type {
	case "ping", "":
		return []byte("pong"), nil
	case "add":
		return handleAdd(event)
	default:
		return nil, errors.New("unknown event type")
	}
}

func handleAdd(event Event) ([]byte, error) {
	left, ok := event.Payload["left"].(float64)
	if !ok {
		return nil, errors.New("missing left")
	}
	right, ok := event.Payload["right"].(float64)
	if !ok {
		return nil, errors.New("missing right")
	}

	sum := int(left + right)
	return []byte{byte(sum)}, nil
}
