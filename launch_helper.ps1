param([switch]$NoBrowser, [string]$OpenUrl = "http://127.0.0.1:5055/")
$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $AppDir

function Test-ServerUp {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:5055/api/ping" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        return ($r.StatusCode -eq 200)
    } catch {
        return $false
    }
}

if (-not (Test-ServerUp)) {
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
        if (Test-ServerUp) { break }
    }
}

if (-not $NoBrowser) {
    Start-Process $OpenUrl
}
