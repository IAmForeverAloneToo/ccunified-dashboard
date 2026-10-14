package update

import (
	"strconv"
	"strings"
)

// Compare compares two release versions ("1.2.3", "v1.2.3-rc.1"): negative
// if a < b, positive if a > b, 0 if equal. ok is false if either isn't a
// release version (for example "dev").
func Compare(a, b string) (cmp int, ok bool) {
	pa, okA := parse(a)
	pb, okB := parse(b)
	if !okA || !okB {
		return 0, false
	}
	for i := 0; i < 3; i++ {
		if pa.core[i] != pb.core[i] {
			return pa.core[i] - pb.core[i], true
		}
	}
	switch {
	case len(pa.pre) == 0 && len(pb.pre) == 0:
		return 0, true
	case len(pa.pre) == 0:
		return 1, true
	case len(pb.pre) == 0:
		return -1, true
	}
	for i := 0; i < len(pa.pre) && i < len(pb.pre); i++ {
		x, y := pa.pre[i], pb.pre[i]
		nx, errX := strconv.Atoi(x)
		ny, errY := strconv.Atoi(y)
		switch {
		case errX == nil && errY == nil && nx != ny:
			return nx - ny, true
		case errX == nil && errY != nil:
			return -1, true
		case errX != nil && errY == nil:
			return 1, true
		case errX != nil && x != y:
			return strings.Compare(x, y), true
		}
	}
	return len(pa.pre) - len(pb.pre), true
}

type parsed struct {
	core [3]int
	pre  []string
}

func parse(v string) (parsed, bool) {
	v = strings.TrimPrefix(v, "v")
	if i := strings.IndexByte(v, '+'); i >= 0 {
		v = v[:i]
	}
	var p parsed
	core, pre, hasPre := strings.Cut(v, "-")
	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return p, false
	}
	for i, s := range parts {
		n, err := strconv.Atoi(s)
		if err != nil || n < 0 {
			return p, false
		}
		p.core[i] = n
	}
	if hasPre {
		p.pre = strings.Split(pre, ".")
	}
	return p, true
}
