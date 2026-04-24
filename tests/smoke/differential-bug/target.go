package diffbug

func NormalizeDigits(data []byte) (string, error) {
	// BUG: should reject non-digit inputs, but it accepts everything.
	return string(data), nil
}
