param([switch]$NoBrowser, [string]$OpenUrl = "http://127.0.0.1:5055/?v=15")
$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $AppDir

$ExpectedVersion = 15

function Get-RunningVersion {
    try {
        $r = Invoke-RestMethod -Uri "http://127.0.0.1:5055/api/ping" -TimeoutSec 2 -ErrorAction Stop
        if ($r -and $r.ok -and $r.app_version) {
            return [int]$r.app_version
        }
    } catch {}
    return 0
}

function Stop-Port5055 {
    try {
        $netLines = netstat -ano | Select-String ":5055\s+.*LISTENING\s+(\d+)"
        foreach ($m in $netLines) {
            $procId = [int]$m.Matches[0].Groups[1].Value
            if ($procId -gt 4) {
                & taskkill.exe /F /T /PID $procId >$null 2>$null
                Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
            }
        }
    } catch {}
    try {
        $conns = Get-NetTCPConnection -LocalPort 5055 -State Listen -ErrorAction SilentlyContinue
        foreach ($c in $conns) {
            if ($c.OwningProcess -and $c.OwningProcess -gt 4) {
                & taskkill.exe /F /T /PID $c.OwningProcess >$null 2>$null
                Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
            }
        }
    } catch {}
    Start-Sleep -Milliseconds 600
}

$curVer = Get-RunningVersion
if ($curVer -lt $ExpectedVersion) {
    Stop-Port5055

    $dataDir = Join-Path $AppDir "data"
    if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir | Out-Null }

    $pyExe = $null
    $savedFile = Join-Path $dataDir "python_exe.txt"
    if (Test-Path $savedFile) {
        $cand = (Get-Content $savedFile -Raw).Trim()
        if ($cand -and (Test-Path $cand)) { $pyExe = $cand }
    }
    if (-not $pyExe) {
        $found = Get-Command python.exe -ErrorAction SilentlyContinue
        if ($found) { $pyExe = $found.Source } else { $pyExe = "python" }
    }

    $outLog = Join-Path $dataDir "server.log"
    $errLog = Join-Path $dataDir "server_err.log"
    Start-Process -FilePath $pyExe -ArgumentList "`"$(Join-Path $AppDir 'app.py')`"" -WorkingDirectory $AppDir -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog

    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 500
        if ((Get-RunningVersion) -ge $ExpectedVersion) { break }
    }
}

if (-not $NoBrowser) {
    Start-Process $OpenUrl
}
