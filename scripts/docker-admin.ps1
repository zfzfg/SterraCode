[CmdletBinding()]
param([Parameter(Mandatory)][ValidateSet('backup', 'restore', 'import', 'reset-password', 'usage')][string]$Operation, [string]$Path, [switch]$Offline)
. "$PSScriptRoot/docker-common.ps1"
Test-SterraDocker
Set-SterraComposeArgs
switch ($Operation) {
    'backup' {
        if (-not $Path) { throw '-Path zu leerem Backupziel fehlt.' }
        $target = [IO.Path]::GetFullPath($Path)
        New-Item -ItemType Directory -Path $target -Force | Out-Null
        Invoke-SterraCompose stop
        $images = Invoke-SterraCompose images --format json
        $options = @('run', '--rm', '--no-deps', '-e', "STERRACODE_BACKUP_IMAGES=$images", '-v', "${target}:/backup", 'admin', 'backup')
        if ($Offline) { $options += '--offline' }
        Invoke-SterraCompose @options
        if ($Offline) {
            $project = Get-SterraEnv 'COMPOSE_PROJECT_NAME' 'sterracode'
            & docker image save "${project}-app:1.0.0" "${project}-runner:1.0.0" -o (Join-Path $target 'images.tar')
            if ($LASTEXITCODE) { throw 'Imagearchiv fehlgeschlagen. Stack bleibt gestoppt.' }
        }
        Invoke-SterraCompose up -d --remove-orphans
    }
    'restore' {
        Assert-SterraStopped
        $source = (Resolve-Path -LiteralPath $Path).Path
        Invoke-SterraCompose run --rm --no-deps -v "${source}:/backup:ro" admin restore
    }
    'import' {
        Assert-SterraStopped
        $source = (Resolve-Path -LiteralPath $Path).Path
        Invoke-SterraCompose run --rm --no-deps -v "${source}:/import:ro" admin import
    }
    'reset-password' {
        Assert-SterraStopped
        Invoke-SterraCompose run --rm --no-deps --user 10001:10001 app node docker/admin.mjs reset-password
        Write-Host 'Neuen Schlüssel zur Einrichtung verwenden; anschließend .\start-docker.ps1.'
    }
    'usage' { Invoke-SterraCompose run --rm --no-deps admin usage }
}
