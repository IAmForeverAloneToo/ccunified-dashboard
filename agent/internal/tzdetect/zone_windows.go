//go:build windows

package tzdetect

import "golang.org/x/sys/windows/registry"

func platformZone() string {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, `SYSTEM\CurrentControlSet\Control\TimeZoneInformation`, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer k.Close()
	id, _, err := k.GetStringValue("TimeZoneKeyName")
	if err != nil {
		return ""
	}
	return FromWindowsID(id)
}
