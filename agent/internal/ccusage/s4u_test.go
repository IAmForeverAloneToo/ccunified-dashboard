package ccusage

import (
	"testing"
	"unicode/utf16"
	"unsafe"
)

func TestS4ULogonLayout(t *testing.T) {
	// The C layout: two 32-bit fields, then UNICODE_STRINGs (two 16-bit
	// lengths, then a pointer at its natural alignment).
	ptr := unsafe.Sizeof(uintptr(0))
	if got := unsafe.Offsetof(unicodeString{}.Buffer); got != max(4, ptr) {
		t.Errorf("UNICODE_STRING.Buffer at offset %d", got)
	}
	if got := unsafe.Sizeof(unicodeString{}); got != 2*max(4, ptr) {
		t.Errorf("UNICODE_STRING is %d bytes", got)
	}
	if got := unsafe.Offsetof(s4uLogon{}.Name); got != 8 {
		t.Errorf("Name at offset %d", got)
	}
	if got := unsafe.Offsetof(s4uLogon{}.Domain); got != 8+unsafe.Sizeof(unicodeString{}) {
		t.Errorf("Domain at offset %d", got)
	}
}

func TestS4ULogonBuffer(t *testing.T) {
	read := func(s unicodeString) string {
		if s.Buffer == nil {
			return ""
		}
		return string(utf16.Decode(unsafe.Slice(s.Buffer, s.Length/2)))
	}
	inside := func(buf []byte, s unicodeString) bool {
		start := uintptr(unsafe.Pointer(&buf[0]))
		p := uintptr(unsafe.Pointer(s.Buffer))
		return p >= start+unsafe.Sizeof(s4uLogon{}) && p+uintptr(s.Length) <= start+uintptr(len(buf))
	}

	buf := s4uLogonBuffer("älice", "LAPTOP-7")
	req := (*s4uLogon)(unsafe.Pointer(&buf[0]))
	if req.MessageType != 12 || req.Flags != 0 {
		t.Errorf("message type %d, flags %d", req.MessageType, req.Flags)
	}
	if read(req.Name) != "älice" || read(req.Domain) != "LAPTOP-7" {
		t.Errorf("names %q, %q", read(req.Name), read(req.Domain))
	}
	if req.Name.Length != 10 || req.Name.MaximumLength != 10 || req.Domain.Length != 16 {
		t.Errorf("lengths %d/%d, %d", req.Name.Length, req.Name.MaximumLength, req.Domain.Length)
	}
	if !inside(buf, req.Name) || !inside(buf, req.Domain) {
		t.Error("the names aren't in the buffer, after the structure")
	}
	if want := int(unsafe.Sizeof(s4uLogon{})) + 2*(5+8); len(buf) != want {
		t.Errorf("buffer is %d bytes, want %d", len(buf), want)
	}

	// A domain account's realm may be left out.
	buf = s4uLogonBuffer("alice@corp.example", "")
	req = (*s4uLogon)(unsafe.Pointer(&buf[0]))
	if read(req.Name) != "alice@corp.example" || req.Domain.Buffer != nil || req.Domain.Length != 0 {
		t.Errorf("name %q, domain %+v", read(req.Name), req.Domain)
	}
}
