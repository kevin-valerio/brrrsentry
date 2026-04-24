package decodeok

import (
	"encoding/binary"
	"errors"
)

func DecodePacket(data []byte) ([]byte, error) {
	if len(data) < 4 {
		return nil, errors.New("short header")
	}

	n := int(binary.BigEndian.Uint32(data[:4]))
	if n < 0 || n > 1_000_000 {
		return nil, errors.New("invalid length")
	}

	if len(data[4:]) < n {
		return nil, errors.New("short payload")
	}

	payload := make([]byte, n)
	copy(payload, data[4:4+n])
	return payload, nil
}
