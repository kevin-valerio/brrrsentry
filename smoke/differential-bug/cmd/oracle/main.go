package main

import (
	"fmt"
	"io"
	"os"
)

func main() {
	input, err := io.ReadAll(os.Stdin)
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}

	if !isAllDigits(input) {
		fmt.Fprintln(os.Stderr, "invalid: non-digit input")
		os.Exit(1)
	}

	fmt.Print(string(input))
}

func isAllDigits(input []byte) bool {
	for _, b := range input {
		if b < '0' || b > '9' {
			return false
		}
	}
	return true
}
