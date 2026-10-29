//go:build !windows

package ccusage

// LogOn prepares running ccusage as an account. Here root runs it with the
// account's ids (see runAs); an account without ids (-1) changes nothing.
func LogOn(a Account) (*Account, error) {
	if a.UID < 0 || a.GID < 0 {
		return nil, nil
	}
	return &a, nil
}

// Close ends what LogOn started (nothing here).
func (a *Account) Close() {}
