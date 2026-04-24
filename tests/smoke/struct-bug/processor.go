package structbug

import "bytes"

type Input struct {
	Data []byte
	S    string
	N    int
	OK   bool
}

func Process(in Input) error {
	if in.OK && in.N == 1337 && in.S == "BOOMMOOB" && bytes.Equal(in.Data, []byte("A")) {
		panic("boom")
	}
	return nil
}
