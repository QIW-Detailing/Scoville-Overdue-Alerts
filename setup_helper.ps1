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
    Write-Host "and then double-click Setup-This-PC inside the extracted folder." -ForegroundColor Yellow
    Write-Host ""
    Read-Host "Press Enter to close"
    exit 1
}

# Remove Windows Mark-of-the-Web (Zone.Identifier) from extracted .zip files
try {
    Get-ChildItem -Path $AppDir -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue
} catch {}

function Test-RealPython([string]$ExePath) {
    if ([string]::IsNullOrWhiteSpace($ExePath)) { return $false }
    try {
        $out = & $ExePath -c "import sys; print('REAL_PY_OK' if sys.version_info >= (3,9) else 'OLD')" 2>$null
        if ($LASTEXITCODE -eq 0 -and ($out -join "") -match "REAL_PY_OK") {
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

    # Check standard per-user & system Python locations (newest first)
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
                $candidates.Add(($fromPy -join "").Trim())
            }
        }
    } catch {}

    # Check PATH python (including genuine Microsoft Store Python; fake stub fails REAL_PY_OK test)
    $pathCmds = Get-Command python.exe -All -ErrorAction SilentlyContinue
    foreach ($c in $pathCmds) {
        if ($c.Source) { $candidates.Add($c.Source) }
    }

    foreach ($cand in $candidates) {
        if (Test-RealPython $cand) {
            # Resolve sys.executable so we store the concrete interpreter path
            try {
                $realExe = (& $cand -c "import sys; print(sys.executable)" 2>$null | Select-Object -Last 1).Trim()
                if ($realExe -and (Test-Path $realExe)) { return $realExe }
            } catch {}
            return $cand
        }
    }
    return $null
}

$pyExe = Find-WorkingPython

if (-not $pyExe) {
    Write-Host "[1/4] Python 3 not found on this PC." -ForegroundColor Yellow
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
        Start-Process -FilePath $installerPath -ArgumentList "/quiet InstallAllUsers=0 PrependPath=1 Include_test=0" -Wait | Out-Null
        $pyExe = Find-WorkingPython
    }

    if (-not $pyExe) {
        Write-Host ""
        Write-Host "[ERROR] Could not automatically install Python 3.12 on this PC." -ForegroundColor Red
        Write-Host "Please install Python 3.12 from https://www.python.org/downloads/ and re-run Setup-This-PC." -ForegroundColor Yellow
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
    $launchPs1 = Join-Path $AppDir "launch_helper.ps1"

    $desktop = [Environment]::GetFolderPath("Desktop")
    $lnk = $ws.CreateShortcut((Join-Path $desktop "Scoville Overdue Alerts.lnk"))
    $lnk.TargetPath = "powershell.exe"
    $lnk.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launchPs1`""
    $lnk.WorkingDirectory = $AppDir
    $lnk.WindowStyle = 7
    $lnk.Description = "Start Scoville Overdue Alerts local helper and open dashboard"
    $lnk.Save()

    $startupDir = [Environment]::GetFolderPath("Startup")
    $startupLnk = $ws.CreateShortcut((Join-Path $startupDir "Scoville Overdue Alerts Helper.lnk"))
    $startupLnk.TargetPath = "powershell.exe"
    $startupLnk.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launchPs1`" -NoBrowser"
    $startupLnk.WorkingDirectory = $AppDir
    $startupLnk.WindowStyle = 7
    $startupLnk.Description = "Auto-start Scoville Overdue Alerts local helper in background"
    $startupLnk.Save()
} catch {
    Write-Host "      (Note: Could not create shortcut: $($_.Exception.Message))" -ForegroundColor Yellow
}

Write-Host "[4/4] Starting local Scoville & Outlook helper on http://127.0.0.1:5055 ..." -ForegroundColor Cyan

# Forcefully stop ANY old Python / wscript process listening on port 5055 (including older folders!)
try {
    $netLines = netstat -ano | Select-String ":5055\s+.*LISTENING\s+(\d+)"
    foreach ($m in $netLines) {
        $procId = [int]$m.Matches[0].Groups[1].Value
        if ($procId -gt 4) {
            Write-Host "      Stopping older helper process (PID $procId) on port 5055..." -ForegroundColor Yellow
            & taskkill.exe /F /T /PID $procId >$null 2>$null
            Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        }
    }
} catch {}
try {
    $oldListeners = Get-NetTCPConnection -LocalPort 5055 -State Listen -ErrorAction SilentlyContinue
    foreach ($conn in $oldListeners) {
        if ($conn.OwningProcess -and $conn.OwningProcess -gt 4) {
            & taskkill.exe /F /T /PID $conn.OwningProcess >$null 2>$null
            Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
        }
    }
} catch {}
Start-Sleep -Milliseconds 800

# Launch app.py directly via PowerShell Start-Process (avoids VBScript / Defender ASR blocks!)
$outLog = Join-Path $dataDir "server.log"
$errLog = Join-Path $dataDir "server_err.log"
Start-Process -FilePath $pyExe -ArgumentList "`"$(Join-Path $AppDir 'app.py')`"" -WorkingDirectory $AppDir -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog

$serverReady = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $ping = Invoke-RestMethod -Uri "http://127.0.0.1:5055/api/ping" -TimeoutSec 2 -ErrorAction Stop
        if ($ping -and $ping.ok -and ([int]$ping.app_version -ge 16)) {
            $serverReady = $true
            break
        }
    } catch {}
}

if (-not $serverReady) {
    Write-Host ""
    Write-Host "[ERROR] New helper (v16) did not start cleanly on port 5055." -ForegroundColor Red
    if (Test-Path $errLog) {
        Write-Host "--- Error Log ---" -ForegroundColor Yellow
        Get-Content $errLog -Tail 25
    }
    if (Test-Path $outLog) {
        Write-Host "--- Output Log ---" -ForegroundColor Yellow
        Get-Content $outLog -Tail 25
    }
    Read-Host "Press Enter to close"
    exit 1
}

Write-Host ""
Write-Host "========================================================" -ForegroundColor Green
Write-Host "  SUCCESS! Helper v2.6 is LIVE at http://127.0.0.1:5055" -ForegroundColor Green
Write-Host "========================================================" -ForegroundColor Green
Write-Host "Opening updated dashboard in your browser now..." -ForegroundColor Cyan

if (-not $NoBrowser) {
    Start-Process "http://127.0.0.1:5055/?v=16"
    Start-Sleep -Seconds 3
}
