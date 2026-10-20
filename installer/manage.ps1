[CmdletBinding()]
param([ValidateSet('status', 'check', 'install', 'recover', 'migrate', 'migrate-recover')][string]$Action = 'status', [string]$BackupDirectory)
$ErrorActionPreference = 'Stop'
$Action = $Action.ToLowerInvariant()
$installation = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'installation.json') -Raw | ConvertFrom-Json
if ($installation.project -notmatch '^[a-z][a-z0-9-]{0,39}$') { throw 'Invalid installation identity.' }
if ($Action -in @('migrate', 'migrate-recover', 'recover')) {
    if ($installation.updaterImage -notmatch '^ghcr\.io/zfzfg/sterracode-updater@sha256:[a-f0-9]{64}$') { throw 'Invalid updater image.' }
    $options = @()
    if ($Action -eq 'recover') {
        $runnerKey = $installation.volumes.'runner-key'
        if ($runnerKey -notmatch '^[a-z0-9_-]+$') { throw 'Invalid runner key volume.' }
        $options = @('--network', "$($installation.project)_backend", '-v', "$($installation.project)_updater-key:/run/updater:ro", '-v', "${runnerKey}:/run/runner:ro")
    }
    if ($Action -eq 'migrate') {
        if (-not $BackupDirectory -or -not (Test-Path -LiteralPath $BackupDirectory -PathType Container)) { throw 'An offline backup directory is required.' }
        $backup = (Resolve-Path -LiteralPath $BackupDirectory).Path
        $options = @('--mount', "type=bind,source=$backup,target=/backup,readonly")
    }
    & docker run --rm --init --mount "type=bind,source=$PSScriptRoot,target=/installation" -v /var/run/docker.sock:/var/run/docker.sock @options $installation.updaterImage $Action
    if ($LASTEXITCODE) { throw 'Migration failed. Existing volumes were retained. Review the recovery guide.' }
    return
}
& docker exec "$($installation.project)-updater" node /app/installer/runtime/cli.mjs $Action
if ($LASTEXITCODE) { throw 'Management command failed. Check that Docker and the updater are running.' }
