[CmdletBinding()]
param([string]$BindIP = '', [int]$Port = 3000, [string]$PublicUrl = '', [switch]$AllInterfaces, [switch]$NonInteractive, [switch]$Diagnose, [switch]$Firewall)
. "$PSScriptRoot/scripts/docker-common.ps1"
Test-SterraDocker
$ips = @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.InterfaceAlias -notmatch 'vEthernet|WSL|Docker|VirtualBox|VMware|Tailscale|Loopback' -and $_.AddressState -eq 'Preferred' } | Select-Object -ExpandProperty IPAddress -Unique)
if ($Diagnose) {
    $configured = Get-SterraEnv 'STERRACODE_BIND_IP'
    Write-Host "Konfiguriert: $configured; aktuelle LAN-Adressen: $($ips -join ', ')"
    if ($configured -notin $ips) { Write-Host 'Adresse prüfen, .env anpassen und .\start-docker.ps1 ausführen.' }
    return
}
if (-not (Test-Path -LiteralPath '.env')) {
    if (-not $BindIP) {
        if ($ips.Count -eq 1) { $BindIP = $ips[0] }
        elseif ($NonInteractive) { throw 'Mehrere/keine LAN-Adressen. -BindIP explizit angeben.' }
        else {
            if (-not $ips.Count) { throw 'Keine LAN-Adresse gefunden. -BindIP angeben.' }
            for ($i = 0; $i -lt $ips.Count; $i++) { Write-Host "[$($i + 1)] $($ips[$i])" }
            $choice = [int](Read-Host 'LAN-Adresse auswählen')
            if ($choice -lt 1 -or $choice -gt $ips.Count) { throw 'Ungültige Auswahl.' }
            $BindIP = $ips[$choice - 1]
        }
    }
    $parsed = $null
    if (-not [Net.IPAddress]::TryParse($BindIP, [ref]$parsed) -or $parsed.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { throw 'Für die erste LAN-Stufe eine IPv4-Adresse angeben.' }
    if ($BindIP -eq '0.0.0.0' -and -not $AllInterfaces) {
        if ($NonInteractive -or (Read-Host 'Wirklich auf allen Interfaces veröffentlichen? [ja/NEIN]') -ne 'ja') { throw 'Alle Interfaces erfordern eine ausdrückliche Bestätigung oder -AllInterfaces.' }
    }
    if ($Port -lt 1 -or $Port -gt 65535) { throw 'Ungültiger Port.' }
    if ($BindIP -eq '0.0.0.0' -and -not $PublicUrl) { throw 'Bei allen Interfaces zusätzlich -PublicUrl mit der konkreten LAN-/Domainadresse angeben.' }
    if (-not $PublicUrl) { $PublicUrl = "http://${BindIP}:$Port" }
    $publicUri = $null
    if ($PublicUrl -match '\s' -or -not [Uri]::TryCreate($PublicUrl, [UriKind]::Absolute, [ref]$publicUri) -or $publicUri.Scheme -notin @('http', 'https') -or $publicUri.UserInfo -or $publicUri.Query -or $publicUri.Fragment -or $publicUri.AbsolutePath -notin @('', '/') -or $publicUri.Host -in @('0.0.0.0', '[::]', '::')) { throw 'PublicUrl muss eine konkrete http-/https-URL ohne Unterpfad, Zugangsdaten oder Query sein.' }
    $lines = foreach ($line in [IO.File]::ReadAllLines((Join-Path $script:SterraRoot '.env.example'))) {
        if ($line.StartsWith('STERRACODE_BIND_IP=')) { "STERRACODE_BIND_IP=$BindIP" }
        elseif ($line.StartsWith('STERRACODE_PORT=')) { "STERRACODE_PORT=$Port" }
        elseif ($line.StartsWith('STERRACODE_PUBLIC_URL=')) { "STERRACODE_PUBLIC_URL=$PublicUrl" }
        else { $line }
    }
    $temporaryEnv = Join-Path $script:SterraRoot ('.env-install-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllLines($temporaryEnv, $lines, [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporaryEnv -Destination (Join-Path $script:SterraRoot '.env')
    } finally { if (Test-Path -LiteralPath $temporaryEnv) { Remove-Item -LiteralPath $temporaryEnv } }
} else { Write-Host 'Vorhandene .env und Zugangsdaten bleiben erhalten.' }
Set-SterraComposeArgs
Invoke-SterraCompose config --quiet
$running = Invoke-SterraCompose ps --status running --quiet app
if (-not $running -and (Get-SterraEnv 'STERRACODE_PROXY_MODE' 'off') -eq 'off') {
    $socket = [Net.Sockets.Socket]::new([Net.Sockets.AddressFamily]::InterNetwork, [Net.Sockets.SocketType]::Stream, [Net.Sockets.ProtocolType]::Tcp)
    try { $socket.Bind([Net.IPEndPoint]::new([Net.IPAddress]::Parse((Get-SterraEnv 'STERRACODE_BIND_IP')), [int](Get-SterraEnv 'STERRACODE_PORT' '3000'))) }
    catch { throw "Port/Bind-Adresse nicht verfügbar: $($_.Exception.Message). .env anpassen." }
    finally { $socket.Dispose() }
}
$drive = Get-PSDrive -Name ([IO.Path]::GetPathRoot($script:SterraRoot).TrimEnd('\', ':'))
if ($drive.Free -lt 8GB) { Write-Warning 'Weniger als 8 GiB auf diesem Laufwerk frei; Speicherort der Docker-VM zusätzlich prüfen.' }
Invoke-SterraCompose build
Invoke-SterraCompose run --rm --no-deps init
Write-Host 'Einrichtungsschlüssel (30 Minuten gültig; vertraulich aufbewahren):'
Invoke-SterraCompose run --rm --no-deps app node docker/admin.mjs setup-key
Invoke-SterraCompose up -d --remove-orphans --wait --wait-timeout 180
$portValue = [int](Get-SterraEnv 'STERRACODE_PORT' '3000')
Write-Host "Browser: $(Get-SterraEnv 'STERRACODE_PUBLIC_URL')"
Write-Host "Firewall-Beispiel (als Administrator): New-NetFirewallRule -DisplayName SterraCode -Direction Inbound -Protocol TCP -LocalPort $portValue -RemoteAddress LocalSubnet -Profile Private -Action Allow"
if ($Firewall -and (Read-Host 'Firewall-Regel im privaten LAN erstellen? [ja/NEIN]') -eq 'ja') {
    $firewallAddress = Get-SterraEnv 'STERRACODE_BIND_IP'
    if ($firewallAddress -eq '0.0.0.0') { $firewallAddress = 'Any' }
    try { New-NetFirewallRule -DisplayName "SterraCode $portValue" -Direction Inbound -Protocol TCP -LocalAddress $firewallAddress -LocalPort $portValue -RemoteAddress LocalSubnet -Profile Private -Action Allow | Out-Null }
    catch { Write-Warning 'Firewall-Regel benötigt Administratorrechte. Angezeigten Befehl separat ausführen.' }
}
Write-Host 'DHCP-Reservierung und Zugriff von einem zweiten LAN-Gerät prüfen. Hinweise: DOCKER-BETRIEB.md'
