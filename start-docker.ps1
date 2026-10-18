[CmdletBinding()]
param([switch]$Build)
. "$PSScriptRoot/scripts/docker-common.ps1"
Test-SterraDocker
if (-not (Test-Path -LiteralPath '.env')) { throw 'Zuerst .\install.ps1 ausführen.' }
Set-SterraComposeArgs
Invoke-SterraCompose config --quiet
if ($Build) { Invoke-SterraCompose build }
Invoke-SterraCompose up -d --remove-orphans --wait --wait-timeout 180
Write-Host "SterraCode: $(Get-SterraEnv 'STERRACODE_PUBLIC_URL')"
