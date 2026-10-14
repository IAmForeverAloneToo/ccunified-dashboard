#!/bin/sh
# Installs ccunified for the current user (no root needed) and starts its setup.
#
#   curl -fsSL https://github.com/IAmForeverAloneToo/ccunified-dashboard/releases/latest/download/install.sh | sh
#
# Environment overrides (testing, forks):
#   CCUNIFIED_REPO           owner/name of the GitHub repository
#   CCUNIFIED_DOWNLOAD_BASE  where the release files are (default: the latest GitHub release)
#   CCUNIFIED_NO_SETUP=1     install only; don't start `ccunified setup`
set -eu

repo="${CCUNIFIED_REPO:-IAmForeverAloneToo/ccunified-dashboard}"
base="${CCUNIFIED_DOWNLOAD_BASE:-https://github.com/$repo/releases/latest/download}"

fail() {
	echo "ccunified install: $*" >&2
	exit 1
}

case "$(uname -s)" in
Linux) os=linux ;;
*) fail "$(uname -s) isn't supported yet (Windows and Linux are)" ;;
esac
case "$(uname -m)" in
x86_64 | amd64) arch=amd64 ;;
aarch64 | arm64) arch=arm64 ;;
*) fail "processor type $(uname -m) isn't supported" ;;
esac

asset="ccunified_${os}_${arch}.tar.gz"
dir="${XDG_DATA_HOME:-$HOME/.local/share}/ccunified"
bindir="$HOME/.local/bin"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

download() {
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL "$1" -o "$2"
	elif command -v wget >/dev/null 2>&1; then
		wget -q -O "$2" "$1"
	else
		fail "needs curl or wget"
	fi
}

echo "Downloading ccunified for Linux ($arch)..."
download "$base/$asset" "$tmp/$asset" || fail "couldn't download $base/$asset"
download "$base/checksums.txt" "$tmp/checksums.txt" || fail "couldn't download checksums.txt"

expected="$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$tmp/checksums.txt")"
[ -n "$expected" ] || fail "checksums.txt has no entry for $asset"
if command -v sha256sum >/dev/null 2>&1; then
	actual="$(sha256sum "$tmp/$asset" | awk '{ print $1 }')"
else
	actual="$(shasum -a 256 "$tmp/$asset" | awk '{ print $1 }')"
fi
[ "$expected" = "$actual" ] || fail "the download doesn't match its checksum; not installing it"

mkdir -p "$tmp/x" "$dir" "$bindir"
tar -xzf "$tmp/$asset" -C "$tmp/x"
[ -f "$tmp/x/ccunified" ] || fail "the download doesn't contain ccunified"
for f in "$tmp/x"/*; do
	name="$(basename "$f")"
	# Move into place (works even while an old copy is running).
	cp "$f" "$dir/.$name.new"
	chmod 755 "$dir/.$name.new"
	mv -f "$dir/.$name.new" "$dir/$name"
done
ln -sf "$dir/ccunified" "$bindir/ccunified"

echo "Installed ccunified $("$dir/ccunified" version | awk '{ print $2 }') in $dir"
case ":$PATH:" in
*":$bindir:"*) ;;
*) echo "Note: $bindir isn't on your PATH yet. Log out and back in, or add it to your shell profile." ;;
esac

if [ "${CCUNIFIED_NO_SETUP:-}" != "1" ]; then
	echo
	if [ -r /dev/tty ] && [ -w /dev/tty ]; then
		"$dir/ccunified" setup </dev/tty
	else
		echo "Now run: $dir/ccunified setup"
	fi
fi
