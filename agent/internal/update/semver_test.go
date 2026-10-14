package update

import "testing"

func TestCompare(t *testing.T) {
	for _, c := range []struct {
		a, b string
		sign int
	}{
		{"1.0.0", "1.0.0", 0}, {"1.0.1", "1.0.0", 1}, {"1.2.0", "1.10.0", -1}, {"v2.0.0", "1.9.9", 1},
		{"1.0.0-rc.1", "1.0.0", -1}, {"1.0.0-rc.2", "1.0.0-rc.10", -1}, {"1.0.0+b5", "1.0.0", 0},
	} {
		got, ok := Compare(c.a, c.b)
		if !ok || (got > 0) != (c.sign > 0) || (got < 0) != (c.sign < 0) {
			t.Errorf("Compare(%s, %s) = %d, %v", c.a, c.b, got, ok)
		}
	}
	if _, ok := Compare("dev", "1.0.0"); ok {
		t.Error("dev compared")
	}
}
