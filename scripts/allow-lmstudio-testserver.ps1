#Requires -RunAsAdministrator
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$taskName = 'SterraCode-LMStudio-Ubuntu-1234'
if (Get-NetFirewallRule -Name $taskName -ErrorAction SilentlyContinue) {
    throw 'Die Regel existiert bereits. Vorhandene Regel bitte zuerst prüfen.'
}
New-NetFirewallRule -Name $taskName `
    -DisplayName 'SterraCode LM Studio vom Ubuntu-Testserver' `
    -Direction Inbound -Action Allow -Protocol TCP -LocalPort 1234 `
    -LocalAddress 192.168.178.64 -RemoteAddress 192.168.178.104 `
    -Profile Private | Select-Object Name, Enabled, Profile, Action
Write-Host 'Nur TCP 1234 vom Ubuntu-Testserver 192.168.178.104 im privaten Netzwerk wurde erlaubt.'
Write-Host "Zum Entfernen: Remove-NetFirewallRule -Name '$taskName'"
