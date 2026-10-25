# Create the root with a domestic mirror first: pip through a proxy is the
# slowest part of setup.
#   pwsh tools/bootstrap.ps1 -Python python -Venv .venv
param(
  [string]$Python = 'python',
  [string]$Venv = '.venv',
  [string]$Index = 'https://mirrors.aliyun.com/pypi/simple'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Venv)) {
  Write-Host "creating $Venv with $Python"
  & $Python -m venv $Venv
}

$pip = Join-Path $Venv 'Scripts\pip.exe'
if (-not (Test-Path $pip)) {
  $pip = Join-Path $Venv 'bin/pip'
}

Write-Host "installing earthengine-api from $Index"
# --no-cache-dir avoids a stale cache lock left by an interrupted run.
& $pip install --no-cache-dir --progress-bar off -i $Index earthengine-api

& $pip show earthengine-api | Select-String '^Version:'

Write-Host ''
Write-Host "next: authenticate and write the config"
Write-Host "  $(Join-Path $Venv 'Scripts\earthengine.exe') authenticate"
Write-Host '  copy dsh-gee/gee.config.example.json to dsh-gee/gee.config.json and fill it in'
