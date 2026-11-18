package app

import "testing"

func TestVerCompare(t *testing.T) {
	tests := []struct {
		a, b string
		want int
	}{
		{"4.30.1", "4.30.0", 1},
		{"v4.30.0", "4.30.0", 0},
		{"4.29.0", "4.30.0", -1},
		{"4.30.10", "4.30.9", 1},
		{"5.0.0", "4.99.99", 1},
		{"4.30.0", "4.30.0.1", -1},
	}

	for _, tt := range tests {
		got := verCompare(tt.a, tt.b)
		if (tt.want > 0 && got <= 0) || (tt.want < 0 && got >= 0) || (tt.want == 0 && got != 0) {
			t.Errorf("verCompare(%q, %q) = %d, want sign %d", tt.a, tt.b, got, tt.want)
		}
	}
}
