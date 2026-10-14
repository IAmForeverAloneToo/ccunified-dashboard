# Installs ccunified for the current user (no admin needed) and starts its setup.
#
#   irm https://github.com/IAmForeverAloneToo/ccunified-dashboard/releases/latest/download/install.ps1 | iex
#
# Environment overrides (testing, forks):
#   CCUNIFIED_REPO           owner/name of the GitHub repository
#   CCUNIFIED_DOWNLOAD_BASE  where the release files are (default: the latest GitHub release)
#   CCUNIFIED_NO_SETUP=1     install only; don't start `ccunified setup`
#
# Everything runs inside one script block, so it works when piped into
# Invoke-Expression and never closes the user's PowerShell window.
& {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $repo = if ($env:CCUNIFIED_REPO) { $env:CCUNIFIED_REPO } else { 'IAmForeverAloneToo/ccunified-dashboard' }
    $base = if ($env:CCUNIFIED_DOWNLOAD_BASE) { $env:CCUNIFIED_DOWNLOAD_BASE } else { "https://github.com/$repo/releases/latest/download" }
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
    $asset = "ccunified_windows_$arch.zip"
    $dir = Join-Path $env:LOCALAPPDATA 'Programs\ccunified'
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('ccunified-' + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $tmp | Out-Null

    try {
        Write-Host "Downloading ccunified for Windows ($arch)..."
        Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile (Join-Path $tmp $asset)
        Invoke-WebRequest -UseBasicParsing -Uri "$base/checksums.txt" -OutFile (Join-Path $tmp 'checksums.txt')

        $entry = Get-Content (Join-Path $tmp 'checksums.txt') | Where-Object {
            $parts = $_ -split '\s+'
            $parts.Count -ge 2 -and ($parts[1] -eq $asset -or $parts[1] -eq "*$asset")
        } | Select-Object -First 1
        if (-not $entry) { throw "checksums.txt has no entry for $asset" }
        $expected = ($entry -split '\s+')[0].ToLowerInvariant()
        $actual = (Get-FileHash -Algorithm SHA256 -Path (Join-Path $tmp $asset)).Hash.ToLowerInvariant()
        if ($expected -ne $actual) { throw "The download doesn't match its checksum; not installing it." }

        $unpacked = Join-Path $tmp 'x'
        Expand-Archive -Path (Join-Path $tmp $asset) -DestinationPath $unpacked -Force
        if (-not (Test-Path (Join-Path $unpacked 'ccunified.exe'))) { throw "The download doesn't contain ccunified.exe" }

        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        Get-ChildItem -Path $unpacked -File | ForEach-Object {
            $target = Join-Path $dir $_.Name
            if (Test-Path $target) {
                # A running program can't be overwritten, but it can be renamed.
                $old = "$target.old"
                Remove-Item -Force -ErrorAction SilentlyContinue $old
                Move-Item -Force $target $old
            }
            Move-Item -Force $_.FullName $target
        }

        # Add the folder to the user's PATH, keeping the value's registry type
        # (setting it through [Environment] would expand %VARIABLES% in it).
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
        $raw = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $entries = @($raw -split ';' | Where-Object { $_ })
        if (-not ($entries | Where-Object { $_.TrimEnd('\') -ieq $dir })) {
            $kind = if ($raw) { $key.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
            $key.SetValue('Path', (($entries + $dir) -join ';'), $kind)
            # Tell Windows the environment changed, so new terminals see it.
            [Environment]::SetEnvironmentVariable('CCUNIFIED_PATH_REFRESH', '1', 'User')
            [Environment]::SetEnvironmentVariable('CCUNIFIED_PATH_REFRESH', $null, 'User')
        }
        $key.Close()
        if (-not (($env:Path -split ';') -contains $dir)) { $env:Path = "$env:Path;$dir" }

        $version = & (Join-Path $dir 'ccunified.exe') version
        Write-Host "Installed $version in $dir"
    }
    finally {
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $tmp
    }

    if ($env:CCUNIFIED_NO_SETUP -ne '1') {
        Write-Host ''
        & (Join-Path $dir 'ccunified.exe') setup
    }
}
