# Releasing

Releases are published on this repository's GitHub Releases page, which is
where the one-line installers and `ccunified update` download from. The
repository must stay public for them to work.

## Publish a release

Either:

- **From GitHub:** open **Actions › Release › Run workflow**, keep the branch
  on `Main`, enter the version (for example `0.2.0`) and click **Run
  workflow**. The workflow creates the tag `v0.2.0` on the commit it built.
- **With a tag:** `git tag v0.2.0 && git push origin v0.2.0`.

Versions look like `1.2.3`. A version with a suffix, such as `0.2.0-rc.1`, is
published as a **pre-release**: the installers' `latest` links and
`ccunified update` ignore it, so it's safe for trying a release out. The
workflow refuses versions that aren't in this form, versions that already
exist, and runs from other branches.

## What the Release workflow does

1. **Build:** runs the full check (`npm run check`), builds the dashboard into
   the program (`npm run build:assets`) and builds the release files with
   `agent/tools/release`.
2. **Install for real:** on fresh Windows and Linux machines, serves the files
   locally and installs them with the one-line installers (on Windows, in
   Windows PowerShell 5.1, which every Windows has), checks the installed
   files, version and PATH, then uninstalls and checks that nothing is left.
3. **Publish:** creates the GitHub release with notes generated from the
   commits since the last release.
4. **Install from GitHub:** repeats step 2 against the published release.

Every push to `Main` runs steps 1 and 2 with a version like `0.0.0-ci.42`,
without publishing, so a broken release is caught before anyone releases it.

## The release files

| File | Contents |
|---|---|
| `ccunified_windows_amd64.zip` | `ccunified.exe`, `ccunifiedw.exe` (windowless, for the background sync), `ccusage.exe`, `LICENSE`, `THIRD_PARTY_NOTICES.txt` |
| `ccunified_linux_amd64.tar.gz` | `ccunified`, `ccusage`, `LICENSE`, `THIRD_PARTY_NOTICES.txt` |
| `install.ps1`, `install.sh` | The one-line installers |
| `checksums.txt` | SHA-256 of every file above |

The file names carry no version number, so
`releases/latest/download/<file>` always points at the newest release.
`THIRD_PARTY_NOTICES.txt` is generated with the licenses of the Go standard
library, every Go module the program uses, ccusage, and the npm packages
bundled into the dashboard. The archives use fixed file times, so rebuilding
the same commit with the same tools gives identical files.

To build the files locally:

```sh
npm run build:assets
cd agent && go run ./tools/release -version 1.2.3 -out ../dist
```

## After a release

- Machines update with `ccunified update`; the dashboard marks the ones that
  are behind.
- If the release changes the Worker, the dashboard pages or the database
  migrations (`worker/` or `dashboard/`), the dashboard on Cloudflare also
  needs `ccunified server update`. Say so in the release notes; you can edit
  the generated notes on GitHub after publishing.
