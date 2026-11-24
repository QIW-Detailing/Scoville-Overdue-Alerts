param([switch]$NoBrowser)
$ErrorActionPreference = "Stop"
$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $AppDir

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "  Scoville Overdue Alerts - One-Time Colleague PC Setup" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host ""

if (-not (Test-Path (Join-Path $AppDir "app.py"))) {
    Write-Host "[ERROR] Cannot find app.py in this folder!" -ForegroundColor Red
    Write-Host "Please right-click the downloaded .zip file -> click 'Extract All...'," -ForegroundColor Yellow
    Write-Host "and then double-click Setup-This-PC.bat inside the extracted folder." -ForegroundColor Yellow
    Write-Host ""
    Read-Host "Press Enter to close"
    exit 1
}

function Test-RealPython([string]$ExePath) {
    if ([string]::IsNullOrWhiteSpace($ExePath)) { return $false }
    if ($ExePath -like "*WindowsApps*") { return $false }
    if (-not (Test-Path $ExePath)) { return $false }
    try {
        $ver = & $ExePath -c "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}' if sys.version_info >= (3,9) else 'OLD')" 2>$null
        if ($LASTEXITCODE -eq 0 -and $ver -and $ver -ne "OLD") {
            return $true
        }
    } catch {}
    return $false
}

function Find-WorkingPython {
    $candidates = New-Object System.Collections.Generic.List[string]

    $savedFile = Join-Path $AppDir "data\python_exe.txt"
    if (Test-Path $savedFile) {
        $saved = (Get-Content $savedFile -Raw).Trim()
        if ($saved) { $candidates.Add($saved) }
    }

    # Check common per-user & system Python locations (newest first)
    $searchGlobs = @(
        "$env:LOCALAPPDATA\Programs\Python\Python3*\python.exe",
        "$env:ProgramFiles\Python3*\python.exe",
        "C:\Python3*\python.exe"
    )
    foreach ($g in $searchGlobs) {
        $found = Get-ChildItem -Path $g -ErrorAction SilentlyContinue | Sort-Object FullName -Descending
        foreach ($f in $found) { $candidates.Add($f.FullName) }
    }

    # Check py launcher
    try {
        $pyLauncher = Get-Command py.exe -ErrorAction SilentlyContinue
        if ($pyLauncher) {
            $fromPy = (& $pyLauncher.Source -3 -c "import sys; print(sys.executable)" 2>$null)
            if ($LASTEXITCODE -eq 0 -and $fromPy) {
                $candidates.Add($fromPy.Trim())
            }
        }
    } catch {}

    # Check PATH python (explicitly skipping WindowsApps Microsoft Store stub!)
    $pathCmds = Get-Command python.exe -All -ErrorAction SilentlyContinue
    foreach ($c in $pathCmds) {
        if ($c.Source -and ($c.Source -notlike "*WindowsApps*")) {
            $candidates.Add($c.Source)
        }
    }

    foreach ($cand in $candidates) {
        if (Test-RealPython $cand) {
            return $cand
        }
    }
    return $null
}

$pyExe = Find-WorkingPython

if (-not $pyExe) {
    Write-Host "[1/4] Real Python 3 not found on this PC (ignoring Windows Store stub)." -ForegroundColor Yellow
    Write-Host "      Installing official Python 3.12 (per-user, no admin required)..." -ForegroundColor Cyan

    $wingetCmd = Get-Command winget.exe -ErrorAction SilentlyContinue
    if ($wingetCmd) {
        try {
            & $wingetCmd.Source install -e --id Python.Python.3.12 --scope user --accept-package-agreements --accept-source-agreements
        } catch {}
        $pyExe = Find-WorkingPython
    }

    if (-not $pyExe) {
        Write-Host "      Downloading official Python 3.12 installer from python.org..." -ForegroundColor Cyan
        $installerPath = Join-Path $env:TEMP "python-3.12.8-amd64.exe"
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri "https://www.python.org/ftp/python/3.12.8/python-3.12.8-amd64.exe" -OutFile $installerPath -UseBasicParsing
        Write-Host "      Running silent per-user Python installation (takes ~30 seconds)..." -ForegroundColor Cyan
        $proc = Start-Process -FilePath $installerPath -ArgumentList "/quiet InstallAllUsers=0 PrependPath=1 Include_test=0" -Wait -PassThru
        $pyExe = Find-WorkingPython
    }

    if (-not $pyExe) {
        Write-Host ""
        Write-Host "[ERROR] Could not automatically install Python 3.12 on this PC." -ForegroundColor Red
        Write-Host "Please install Python 3.12 from https://www.python.org/downloads/ and re-run Setup-This-PC.bat." -ForegroundColor Yellow
        Read-Host "Press Enter to close"
        exit 1
    }
}

Write-Host "[1/4] Found Python: $pyExe" -ForegroundColor Green

$dataDir = Join-Path $AppDir "data"
if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir | Out-Null }
[System.IO.File]::WriteAllText((Join-Path $dataDir "python_exe.txt"), $pyExe)

Write-Host "[2/4] Installing required packages (Flask, requests)..." -ForegroundColor Cyan
$pipOk = $false
try {
    & $pyExe -m pip install --disable-pip-version-check -r (Join-Path $AppDir "requirements.txt")
    if ($LASTEXITCODE -eq 0) { $pipOk = $true }
} catch {}

if (-not $pipOk) {
    Write-Host "      Retrying pip install with corporate SSL trusted-host fallback..." -ForegroundColor Yellow
    & $pyExe -m pip install --disable-pip-version-check --trusted-host pypi.org --trusted-host files.pythonhosted.org -r (Join-Path $AppDir "requirements.txt")
}

& $pyExe -c "import flask, requests; print('Packages verified!')"
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] Required packages (flask, requests) failed to install." -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 1
}

Write-Host "[3/4] Creating Desktop & Windows Startup shortcuts..." -ForegroundColor Cyan
try {
    $ws = New-Object -ComObject WScript.Shell
    $vbsPath = Join-Path $AppDir "run_silent.vbs"

    $desktop = [Environment]::GetFolderPath("Desktop")
    $lnk = $ws.CreateShortcut((Join-Path $desktop "Scoville Overdue Alerts.lnk"))
    $lnk.TargetPath = "wscript.exe"
    $lnk.Arguments = "`"$vbsPath`""
    $lnk.WorkingDirectory = $AppDir
    $lnk.Description = "Start Scoville Overdue Alerts local helper and open dashboard"
    $lnk.Save()

    # Also register silent auto-start on Windows login so port 5055 stays ready after reboots
    $startupDir = [Environment]::GetFolderPath("Startup")
    $startupLnk = $ws.CreateShortcut((Join-Path $startupDir "Scoville Overdue Alerts Helper.lnk"))
    $startupLnk.TargetPath = "wscript.exe"
    $startupLnk.Arguments = "`"$vbsPath`" --no-browser"
    $startupLnk.WorkingDirectory = $AppDir
    $startupLnk.Description = "Auto-start Scoville Overdue Alerts local helper in background"
    $startupLnk.Save()
} catch {
    Write-Host "      (Note: Could not create shortcut: $($_.Exception.Message))" -ForegroundColor Yellow
}

Write-Host "[4/4] Starting local Scoville & Outlook helper on http://127.0.0.1:5055 ..." -ForegroundColor Cyan

# Stop any old Python process already listening on port 5055 so fresh code runs cleanly
try {
    $oldListeners = Get-NetTCPConnection -LocalPort 5055 -State Listen -ErrorAction SilentlyContinue
    foreach ($conn in $oldListeners) {
        if ($conn.OwningProcess -and $conn.OwningProcess -gt 4) {
            Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
        }
    }
    Start-Sleep -Milliseconds 500
} catch {}

# Launch via wscript run_silent.vbs --no-browser so we verify port 5055 before opening browser
$vbsFile = Join-Path $AppDir "run_silent.vbs"
Start-Process -FilePath "wscript.exe" -ArgumentList "`"$vbsFile`" --no-browser" -WorkingDirectory $AppDir

$serverReady = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $ping = Invoke-WebRequest -Uri "http://127.0.0.1:5055/api/ping" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        if ($ping.StatusCode -eq 200) {
            $serverReady = $true
            break
        }
    } catch {}
}

if (-not $serverReady) {
    Write-Host ""
    Write-Host "[ERROR] Local helper did not start on port 5055." -ForegroundColor Red
    $logFile = Join-Path $dataDir "server.log"
    if (Test-Path $logFile) {
        Write-Host "--- Startup Log ---" -ForegroundColor Yellow
        Get-Content $logFile -Tail 25
    }
    Read-Host "Press Enter to close"
    exit 1
}

Write-Host ""
Write-Host "========================================================" -ForegroundColor Green
Write-Host "  SUCCESS! Helper is LIVE at http://127.0.0.1:5055" -ForegroundColor Green
Write-Host "========================================================" -ForegroundColor Green
Write-Host "Opening Settings in your browser now..." -ForegroundColor Cyan
Write-Host "Enter your Scoville email & password and click 'Save All Settings'!" -ForegroundColor Yellow

if (-not $NoBrowser) {
    Start-Process "http://127.0.0.1:5055/#settings"
    Start-Sleep -Seconds 3
}
