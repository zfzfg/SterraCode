# SterraCode - check-dependencies.ps1
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null
$Host.UI.RawUI.WindowTitle = "SterraCode - Abhaengigkeiten pruefen"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

function Write-OK   { param($msg) Write-Host "  [OK] $msg" -ForegroundColor Green  }
function Write-Warn { param($msg) Write-Host "  [!]  $msg" -ForegroundColor Yellow }
function Write-Err  { param($msg) Write-Host "  [x]  $msg" -ForegroundColor Red    }
function Write-Info { param($msg) Write-Host "  [-]  $msg" -ForegroundColor Gray   }

Write-Host ""
Write-Host "  =========================================" -ForegroundColor Cyan
Write-Host "   SterraCode - Abhaengigkeiten pruefen"    -ForegroundColor Cyan
Write-Host "  =========================================" -ForegroundColor Cyan
Write-Host ""

$errCount  = 0
$warnCount = 0
$installed = 0

# --- [1/6] Node.js ---
Write-Host "  [1/6] Node.js..." -NoNewline
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Host " FEHLT" -ForegroundColor Red
    Write-Info "Node.js ist nicht installiert."
    Write-Info "Download:  https://nodejs.org  (LTS, Version 18 oder hoeher)"
    Write-Info "Oder:      winget install OpenJS.NodeJS.LTS"
    $errCount++
} else {
    $nodeVer = (& node --version 2>&1).Trim()
    $major   = [int]($nodeVer -replace '^v(\d+)\..*', '$1')
    if ($major -lt 18) {
        Write-Host " $nodeVer (Warnung: v18+ empfohlen)" -ForegroundColor Yellow
        $warnCount++
    } else {
        Write-Host " OK  ($nodeVer)" -ForegroundColor Green
    }
}

# --- [2/6] npm ---
Write-Host "  [2/6] npm..." -NoNewline
$npmCmd = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npmCmd) {
    Write-Host " FEHLT" -ForegroundColor Red
    Write-Info "npm nicht gefunden (wird normalerweise mit Node.js mitgeliefert)."
    $errCount++
} else {
    $npmVer = (& npm --version 2>&1).Trim()
    Write-Host " OK  (v$npmVer)" -ForegroundColor Green
}

# --- [3/6] node_modules ---
Write-Host "  [3/6] npm-Pakete (node_modules)..." -NoNewline
$modulesPath = Join-Path $ScriptDir "node_modules"
if (-not (Test-Path $modulesPath)) {
    Write-Host " FEHLT - installiere..." -ForegroundColor Yellow
    Write-Host ""
    & npm install
    Write-Host ""
    if ($LASTEXITCODE -eq 0) {
        Write-OK "Pakete erfolgreich installiert."
        $installed++
    } else {
        Write-Err "npm install fehlgeschlagen!"
        $errCount++
    }
} else {
    & npm ls --depth=0 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host " Unvollstaendig - aktualisiere..." -ForegroundColor Yellow
        Write-Host ""
        & npm install
        Write-Host ""
        if ($LASTEXITCODE -eq 0) {
            Write-OK "Pakete aktualisiert."
            $installed++
        } else {
            Write-Err "npm install fehlgeschlagen!"
            $errCount++
        }
    } else {
        Write-Host " OK" -ForegroundColor Green
    }
}

# --- [4/6] Python ---
Write-Host "  [4/6] Python (fuer Python-Ausfuehrung)..." -NoNewline
$py  = Get-Command python  -ErrorAction SilentlyContinue
$py3 = Get-Command python3 -ErrorAction SilentlyContinue
if (-not $py -and -not $py3) {
    Write-Host " FEHLT (optional)" -ForegroundColor Yellow
    Write-Info "Python wird benoetigt um Python-Code auszufuehren."
    Write-Info "Download:  https://www.python.org/downloads"
    Write-Info "Oder:      winget install Python.Python.3"
    $warnCount++
} else {
    $pyExe = if ($py) { "python" } else { "python3" }
    $pyVer = (& $pyExe --version 2>&1).Trim()
    Write-Host " OK  ($pyVer)" -ForegroundColor Green
}

# --- [5/6] Go ---
Write-Host "  [5/6] Go (fuer Go-Ausfuehrung)..." -NoNewline
$goCmd = Get-Command go -ErrorAction SilentlyContinue
if (-not $goCmd) {
    Write-Host " FEHLT (optional)" -ForegroundColor Yellow
    Write-Info "Go wird benoetigt um Go-Code auszufuehren."
    Write-Info "Download:  https://go.dev/dl"
    Write-Info "Oder:      winget install GoLang.Go"
    $warnCount++
} else {
    $goLine = (& go version 2>&1).Trim()
    $goVer  = ($goLine -split ' ')[2]
    Write-Host " OK  ($goVer)" -ForegroundColor Green
}

# --- [6/6] LM Studio ---
Write-Host "  [6/6] LM Studio (http://localhost:1234)..." -NoNewline
try {
    $null = Invoke-WebRequest -Uri "http://localhost:1234/v1/models" -TimeoutSec 3 -ErrorAction Stop
    Write-Host " OK  (verbunden)" -ForegroundColor Green
} catch {
    Write-Host " nicht erreichbar (optional)" -ForegroundColor Yellow
    Write-Info "LM Studio starten und ein Modell laden."
    Write-Info "Download:  https://lmstudio.ai"
    $warnCount++
}

# --- Ergebnis ---
Write-Host ""
Write-Host "  =========================================" -ForegroundColor Cyan
Write-Host "   Ergebnis"                                -ForegroundColor Cyan
Write-Host "  =========================================" -ForegroundColor Cyan

if ($installed  -gt 0) { Write-OK   "$installed Paket(e) installiert / aktualisiert" }
if ($warnCount  -gt 0) { Write-Warn "$warnCount Warnung(en) - optionale Abhaengigkeiten fehlen" }

if ($errCount -gt 0) {
    Write-Err  "$errCount Fehler - Pflichtabhaengigkeiten fehlen!"
    Write-Host ""
    Write-Err  "SterraCode kann NICHT gestartet werden."
    Write-Info "Bitte die fehlenden Programme installieren und danach erneut pruefen."
    Write-Host ""
} else {
    Write-OK "Alle Pflichtabhaengigkeiten sind vorhanden - SterraCode ist startbereit."
    Write-Host ""
    $answer = Read-Host "  SterraCode jetzt starten? (J/N)"
    if ($answer -eq "J" -or $answer -eq "j" -or $answer -eq "") {
        $startScript = Join-Path $ScriptDir "start.ps1"
        Start-Process powershell.exe -ArgumentList @("-NoExit", "-ExecutionPolicy", "Bypass", "-File", $startScript)
    }
}
