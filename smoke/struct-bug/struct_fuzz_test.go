package structbug

import "testing"

func FuzzStructProcess(f *testing.F) {
	f.Add(Input{Data: []byte("A"), S: "B", N: 7, OK: true})
	f.Add(Input{Data: []byte("A"), S: "BOOMMOOB", N: 1337, OK: true})

	f.Fuzz(func(t *testing.T, in Input) {
		_ = Process(in)
	})
}
