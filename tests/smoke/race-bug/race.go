package racebug

import "runtime"

var sharedCounter int

func RaceOnAnyInput(data []byte) ([]byte, error) {
	done := make(chan struct{})

	go func() {
		for i := 0; i < 200; i++ {
			sharedCounter = len(data) + i
			runtime.Gosched()
		}
		close(done)
	}()

	for i := 0; i < 200; i++ {
		_ = sharedCounter
		runtime.Gosched()
	}

	<-done
	return data, nil
}
