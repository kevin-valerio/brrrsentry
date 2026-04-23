package e2ebug

type Event struct {
	Type    string         `json:"type"`
	Payload map[string]any `json:"payload"`
}
