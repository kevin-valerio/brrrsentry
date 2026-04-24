package grammarjson

import "testing"

func FuzzGrammarJSON(f *testing.F) {
	f.Add([]byte("\"a\""))
	f.Add([]byte("\"b\""))

	f.Fuzz(func(t *testing.T, data []byte) {
		_, _ = Parse(data)
	})
}
