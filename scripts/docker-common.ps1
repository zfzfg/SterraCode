$ErrorActionPreference = 'Stop'
$script:SterraRoot = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $script:SterraRoot
function Get-SterraEnv([string]$Name, [string]$Fallback = '') {
    if (Test-Path -LiteralPath '.env') {
        foreach ($line in [IO.File]::ReadAllLines((Join-Path $script:SterraRoot '.env'))) {
            if ($line.StartsWith("$Name=")) { return $line.Substring($Name.Length + 1).Trim() }
        }
    }
    return $Fallback
}
function Test-SterraDocker {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker fehlt. Docker Desktop mit Linux-Containern installieren.' }
    & docker compose version | Out-Null
    if ($LASTEXITCODE) { throw 'Docker Compose Plugin fehlt.' }
    $os = & docker info --format '{{.OSType}}' 2>$null
    if ($LASTEXITCODE) { throw 'Docker-Daemon nicht erreichbar. Docker Desktop starten.' }
    if ($os -ne 'linux') { throw 'Docker Desktop auf Linux-Container umstellen. Native Windows-Container werden nicht unterstützt.' }
}
function Set-SterraComposeArgs {
    $script:SterraCompose = @('-f', 'compose.yaml')
    switch (Get-SterraEnv 'STERRACODE_PROXY_MODE' 'off') {
        'off' { $script:SterraCompose += @('-f', 'compose.lan.yaml') }
        'caddy' { $script:SterraCompose += @('-f', 'compose.caddy.yaml') }
        'host' { $script:SterraCompose += @('-f', 'compose.host-proxy.yaml') }
        'docker' { $script:SterraCompose += @('-f', 'compose.docker-proxy.yaml') }
        default { throw 'Ungültiger STERRACODE_PROXY_MODE.' }
    }
    if (Get-SterraEnv 'STERRACODE_LM_STUDIO_TOKEN_PATH') { $script:SterraCompose += @('-f', 'compose.lm-secret.yaml') }
    if (Get-SterraEnv 'STERRACODE_ADMIN_PASSWORD_PATH') { $script:SterraCompose += @('-f', 'compose.admin-secret.yaml') }
    if (Get-SterraEnv 'STERRACODE_OPENAI_API_KEY_PATH') { $script:SterraCompose += @('-f', 'compose.openai-secret.yaml') }
}
function Invoke-SterraCompose {
    $project = Get-SterraEnv 'COMPOSE_PROJECT_NAME' 'sterracode'
    $oldPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $imageId = & docker image inspect "${project}-runner:1.1.0" --format '{{.Id}}' 2>$null
    $ErrorActionPreference = $oldPreference
    if ($LASTEXITCODE -eq 0 -and $imageId) { $env:STERRACODE_RUNNER_IMAGE_DIGEST = $imageId.Trim() }
    & docker compose @script:SterraCompose @args
    if ($LASTEXITCODE) { throw "Docker Compose fehlgeschlagen ($LASTEXITCODE)." }
}
function Assert-SterraStopped {
    $running = Invoke-SterraCompose ps --status running --quiet app runner
    if ($running) { throw 'App und Runner zuerst mit .\stop-docker.ps1 stoppen.' }
}
