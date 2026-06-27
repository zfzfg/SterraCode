# SterraCode - start.ps1
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null
$Host.UI.RawUI.WindowTitle = "SterraCode"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

function Write-OK   { param($msg) Write-Host "  [OK] $msg" -ForegroundColor Green  }
function Write-Warn { param($msg) Write-Host "  [!]  $msg" -ForegroundColor Yellow }
function Write-Err  { param($msg) Write-Host "  [x]  $msg" -ForegroundColor Red    }
function Write-Info { param($msg) Write-Host "  [-]  $msg" -ForegroundColor Gray   }

Write-Host ""
Write-Host "  =========================================" -ForegroundColor Cyan
Write-Host "   SterraCode starten"                      -ForegroundColor Cyan
Write-Host "  =========================================" -ForegroundColor Cyan
Write-Host ""

# --- Node.js pruefen ---
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Err  "Node.js wurde nicht gefunden!"
    Write-Info "Bitte zuerst check-dependencies.bat ausfuehren."
    Write-Host ""
    exit 1
}

# --- node_modules pruefen / installieren ---
if (-not (Test-Path (Join-Path $ScriptDir "node_modules"))) {
    Write-Warn "node_modules fehlt - installiere Abhaengigkeiten..."
    Write-Host ""
    & npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Err "npm install fehlgeschlagen."
        exit 1
    }
    Write-Host ""
    Write-OK "Abhaengigkeiten installiert."
    Write-Host ""
}

# --- Port 3000 pruefen ---
$portBusy = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($portBusy) {
    Write-Warn "Port 3000 ist bereits belegt - SterraCode laeuft moeglicherweise bereits."
    Write-Host ""
    $open = Read-Host "  Browser oeffnen? (J/N)"
    if ($open -eq "J" -or $open -eq "j" -or $open -eq "") {
        Start-Process "http://localhost:3000"
    }
    Write-Host ""
    exit 0
}

# --- Browser nach 2 Sekunden im Hintergrund oeffnen ---
$null = Start-Job -ScriptBlock {
    Start-Sleep -Seconds 2
    Start-Process "http://localhost:3000"
}

Write-OK   "Server startet auf http://localhost:3000"
Write-Info "Fenster schliessen oder Ctrl+C druecken um SterraCode zu beenden."
Write-Host ""

# --- Server starten (blockierend) ---
& node (Join-Path $ScriptDir "server\index.js")

Write-Host ""
Write-Warn "Server wurde beendet."
