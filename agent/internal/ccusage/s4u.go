package ccusage

import (
	"unicode/utf16"
	"unsafe"
)

// Windows logs an account on for SYSTEM without its password with an "S4U"
// logon (see logon_windows.go). This is the logon request's layout; it is
// here, not in a Windows-only file, so that it's tested everywhere.

// unicodeString is Windows' UNICODE_STRING: lengths in bytes, without a
// terminating zero.
type unicodeString struct {
	Length        uint16
	MaximumLength uint16
	Buffer        *uint16
}

// s4uLogon is both MSV1_0_S4U_LOGON (local accounts: the account name and
// the computer's name) and KERB_S4U_LOGON (domain accounts: the account's
// user principal name, and an optional realm), which share their layout.
type s4uLogon struct {
	MessageType uint32 // MsV1_0S4ULogon or KerbS4ULogon, both 12
	Flags       uint32
	Name        unicodeString
	Domain      unicodeString
}

const s4uLogonMessage = 12

// s4uLogonBuffer lays the request out as LsaLogonUser requires: the
// structure, then the names' characters right after it, all in one buffer
// that LSA copies as a whole.
func s4uLogonBuffer(name, domain string) []byte {
	n, d := utf16.Encode([]rune(name)), utf16.Encode([]rune(domain))
	head := int(unsafe.Sizeof(s4uLogon{}))
	buf := make([]byte, head+2*(len(n)+len(d)))
	req := (*s4uLogon)(unsafe.Pointer(&buf[0]))
	req.MessageType = s4uLogonMessage
	put := func(s *unicodeString, chars []uint16, at int) {
		if len(chars) == 0 {
			return
		}
		for i, c := range chars {
			buf[at+2*i], buf[at+2*i+1] = byte(c), byte(c>>8)
		}
		s.Length = uint16(2 * len(chars))
		s.MaximumLength = s.Length
		s.Buffer = (*uint16)(unsafe.Pointer(&buf[at]))
	}
	put(&req.Name, n, head)
	put(&req.Domain, d, head+2*len(n))
	return buf
}
