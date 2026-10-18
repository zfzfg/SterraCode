. "$PSScriptRoot/scripts/docker-common.ps1"
Test-SterraDocker
Set-SterraComposeArgs
Invoke-SterraCompose stop
Write-Host 'Stack gestoppt. Alle Volumes bleiben erhalten.'
