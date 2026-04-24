package panicbug

import "bytes"

var seedCrash = []byte("{}")

func CrashOnSeed(data []byte) ([]byte, error) {
	if bytes.Equal(data, seedCrash) {
		panic("boom")
	}
	return data, nil
}
