[CmdletBinding()]
param(
    [string]$Directory = (Join-Path $HOME '.sterracode'),
    [string]$BindIP = '',
    [ValidateRange(1, 65535)][int]$Port = 3000,
    [string]$Project = 'sterracode',
    [switch]$NonInteractive
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Use install.sh on Linux or macOS.' }
if ((Get-CimInstance Win32_OperatingSystem).ProductType -ne 1) { throw 'Windows Server requires a Linux VM. Run install.sh inside that VM.' }
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host 'Docker is not installed. Run the following command, start Docker Desktop with Linux containers, then retry:'
    Write-Host '  winget install --exact --id Docker.DockerDesktop --source winget'
    Write-Host 'Documentation: https://docs.docker.com/desktop/setup/install/windows-install/'
    throw 'Docker installation is required. No SterraCode files were installed.'
}
& docker compose version 2>$null | Out-Null
if ($LASTEXITCODE) { throw 'Docker Compose v2 is missing. Update Docker Desktop.' }
$probePreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try { $dockerInfo = & docker info --format '{{.OSType}} {{.Architecture}}' 2>&1; $probeExit = $LASTEXITCODE }
finally { $ErrorActionPreference = $probePreference }
if ($probeExit) {
    if ("$dockerInfo" -match 'access.+denied|permission denied') { throw 'Docker access denied. Check your Docker Desktop user permissions and retry.' }
    throw 'Docker daemon is unavailable. Start Docker Desktop and retry.'
}
if ("$dockerInfo" -notmatch '^linux (amd64|x86_64|arm64|aarch64)$') { throw 'A Linux Docker daemon on AMD64 or ARM64 is required. Switch Docker Desktop to Linux containers.' }
if ($env:DOCKER_HOST -match '^(tcp|ssh):') { throw 'Run this installer on the Docker host; remote Docker daemons are unsupported.' }
$dockerEndpoint = & docker context inspect --format '{{.Endpoints.docker.Host}}'
if ($LASTEXITCODE -or "$dockerEndpoint" -match '^(tcp|ssh):') { throw 'Select a local Docker context before running this installer.' }
if ($Project -notmatch '^[a-z][a-z0-9-]{0,39}$') { throw 'Project name must contain lowercase letters, digits and hyphens.' }
$Directory = [IO.Path]::GetFullPath($Directory)
if (Test-Path -LiteralPath $Directory) {
    if ((Get-Item -LiteralPath $Directory).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Installation directory must not be a junction or symbolic link.' }
    if (-not (Test-Path -LiteralPath (Join-Path $Directory 'installation.json')) -and @(Get-ChildItem -LiteralPath $Directory -Force | Where-Object { $_.Name -ne '.download' }).Count) { throw 'Installation directory is not empty. Choose another directory or follow the explicit migration instructions.' }
}
$existingDownload = Join-Path $Directory '.download'
if ((Test-Path -LiteralPath $existingDownload) -and ((Get-Item -LiteralPath $existingDownload).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Download directory must not be a junction or symbolic link.' }
if (-not $BindIP -and -not (Test-Path -LiteralPath (Join-Path $Directory 'installation.json'))) {
    $addresses = @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.InterfaceAlias -notmatch 'vEthernet|WSL|Docker|VirtualBox|VMware|Tailscale|Loopback' -and $_.AddressState -eq 'Preferred' } | Select-Object -ExpandProperty IPAddress -Unique)
    if ($addresses.Count -eq 1) { $BindIP = $addresses[0] }
    elseif ($NonInteractive) { throw 'Use -BindIP when multiple or no LAN addresses are available.' }
    else { Write-Host "Available LAN addresses: $($addresses -join ', ')"; $BindIP = Read-Host 'Enter an IPv4 address (127.0.0.1 for local access)' }
}
if (-not $BindIP) { $BindIP = '127.0.0.1' }
$parsedIP = $null
if (-not [Net.IPAddress]::TryParse($BindIP, [ref]$parsedIP) -or $parsedIP.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or $BindIP -eq '0.0.0.0') { throw 'A concrete IPv4 address is required.' }
if (-not (Test-Path -LiteralPath (Join-Path $Directory 'installation.json'))) {
    $socket = [Net.Sockets.Socket]::new([Net.Sockets.AddressFamily]::InterNetwork, [Net.Sockets.SocketType]::Stream, [Net.Sockets.ProtocolType]::Tcp)
    try { $socket.Bind([Net.IPEndPoint]::new($parsedIP, $Port)) }
    catch { throw 'The address or port is unavailable. Select a different address or port.' }
    finally { $socket.Dispose() }
}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$download = Join-Path $Directory '.download'
New-Item -ItemType Directory -Path $download -Force | Out-Null
Write-Host 'Downloading the latest published stable SterraCode release...'
$metadataPath = Join-Path $download 'release.json'
Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/zfzfg/SterraCode/releases/latest/download/release.json' -OutFile $metadataPath
$release = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
if ($release.version -notmatch '^\d+\.\d+\.\d+$' -or $release.images.updater -notmatch '^ghcr\.io/zfzfg/sterracode-updater@sha256:[a-f0-9]{64}$' -or $release.packageSHA256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid release metadata. Nothing was executed.' }
$packagePath = Join-Path $download 'installer.zip'
Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/zfzfg/SterraCode/releases/download/v$($release.version)/installer.zip" -OutFile $packagePath
if ((Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $release.packageSHA256) { throw 'Installation package checksum mismatch.' }
$zone = 'UTC'
try {
    $ianaZone = $null
    if ([TimeZoneInfo]::TryConvertWindowsIdToIanaId([TimeZoneInfo]::Local.Id, [ref]$ianaZone)) { $zone = $ianaZone }
} catch {
    # PowerShell 5.1 uses Windows zone names; Node's ICU maps them during setup.
    $zone = [TimeZoneInfo]::Local.Id
}
$options = @{ bindIP = $BindIP; port = $Port; project = $Project; timeZone = $zone } | ConvertTo-Json -Compress
Write-Host 'Pulling verified release images. This can take several minutes.'
& docker pull $release.images.updater
if ($LASTEXITCODE) { throw 'Could not download the updater image. Check your network connection.' }
& docker run --rm --init --mount "type=bind,source=$Directory,target=/installation" -v /var/run/docker.sock:/var/run/docker.sock -e "STERRA_INSTALL_OPTIONS=$options" $release.images.updater setup
if ($LASTEXITCODE) { throw 'SterraCode installation failed. Review the error above; existing data was retained.' }
