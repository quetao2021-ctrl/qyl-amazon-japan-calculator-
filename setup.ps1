param(
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServerScript = Join-Path $Root 'scripts\gemini_lan_server.js'
$HealthUrl = 'http://127.0.0.1:8787/api/health'
$PortalUrl = 'http://127.0.0.1:8787'
$NodeModules = Join-Path $Root 'node_modules'
$PlaywrightModule = Join-Path $NodeModules 'playwright'
$PwCacheDir = Join-Path $env:LOCALAPPDATA 'ms-playwright'

function Write-Step($text) {
  Write-Host "[QYL] $text" -ForegroundColor Cyan
}

function Ensure-Dir($path) {
  if (-not (Test-Path $path)) {
    New-Item -ItemType Directory -Force -Path $path | Out-Null
  }
}

function Test-Health() {
  try {
    $resp = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 3
    return [bool]$resp.ok
  } catch {
    return $false
  }
}

function Wait-Health($seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Health) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Get-ServerProcesses() {
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.Name -eq 'node.exe' -and
      $_.CommandLine -match 'gemini_lan_server\.js'
    }
}

function Ensure-Node() {
  $node = Get-Command node -ErrorAction SilentlyContinue
  $npm = Get-Command npm -ErrorAction SilentlyContinue
  $npx = Get-Command npx -ErrorAction SilentlyContinue

  if (-not $node -or -not $npm -or -not $npx) {
    throw 'Node.js / npm / npx was not found. Please install Node.js 20+ from https://nodejs.org/'
  }
}

function Ensure-NpmDependencies() {
  $needInstall = $false
  if (-not (Test-Path $NodeModules)) { $needInstall = $true }
  if (-not (Test-Path $PlaywrightModule)) { $needInstall = $true }

  if ($needInstall) {
    Write-Step 'Installing npm dependencies...'
    Push-Location $Root
    try {
      & npm install
    } finally {
      Pop-Location
    }
  } else {
    Write-Step 'npm dependencies already exist. Skip npm install.'
  }
}

function Ensure-PlaywrightChromium() {
  $installed = $false
  if (Test-Path $PwCacheDir) {
    $dirs = Get-ChildItem $PwCacheDir -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -like 'chromium-*' }
    if ($dirs -and $dirs.Count -gt 0) {
      $installed = $true
    }
  }

  if (-not $installed) {
    Write-Step 'Installing Playwright Chromium...'
    Push-Location $Root
    try {
      & npx playwright install chromium
    } finally {
      Pop-Location
    }
  } else {
    Write-Step 'Playwright Chromium already exists. Skip browser install.'
  }
}

function Ensure-WorkspaceDirs() {
  Write-Step 'Creating runtime folders...'
  Ensure-Dir (Join-Path $Root 'output')
  Ensure-Dir (Join-Path $Root 'output\lan_portal_jobs')
  Ensure-Dir (Join-Path $Root 'output\lan_portal_uploads')
  Ensure-Dir (Join-Path $Root '.gemini_profile_live')
}

function Start-Server() {
  if (Test-Health) {
    Write-Step 'Local server is already running.'
    return
  }

  $stale = @(Get-ServerProcesses)
  foreach ($proc in $stale) {
    try {
      Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
    } catch {
      # ignore stale process stop failure
    }
  }

  Write-Step 'Starting local server...'
  $proc = Start-Process node -ArgumentList 'scripts/gemini_lan_server.js' -WorkingDirectory $Root -PassThru
  if (-not (Wait-Health 30)) {
    throw "Local server failed to start. Check: $ServerScript"
  }

  Write-Step "Local server started. PID=$($proc.Id)"
}

Ensure-Node
Ensure-NpmDependencies
Ensure-PlaywrightChromium
Ensure-WorkspaceDirs
Start-Server

if (-not $NoBrowser) {
  Write-Step 'Opening QYL portal...'
  Start-Process $PortalUrl | Out-Null
}

Write-Host ''
Write-Host 'QYL portal is ready.' -ForegroundColor Green
Write-Host "URL: $PortalUrl"
Write-Host 'On first use, please log in to Gemini in the browser once.'
