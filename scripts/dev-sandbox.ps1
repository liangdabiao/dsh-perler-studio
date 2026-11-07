# 在隔离的 DSH_HOME 里重新安装本插件并启动网页版，不碰 ~/.dsh（Windows 版）。
# 用法：powershell -ExecutionPolicy Bypass -File scripts\dev-sandbox.ps1 [-Port 4313]
param(
  [int]$Port = 4313,
  [string]$Sandbox = ""
)
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Sandbox) { $Sandbox = Join-Path (Split-Path -Parent $Root) '.dsh-sandbox' }
New-Item -ItemType Directory -Force -Path $Sandbox | Out-Null
$Sandbox = (Resolve-Path $Sandbox).Path

Set-Location $Root
npm run --silent build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Remove-Item Env:DSH_SESSION_ID -ErrorAction SilentlyContinue
Remove-Item Env:DSH_SHELL -ErrorAction SilentlyContinue
Remove-Item Env:DSH_WEB_URL -ErrorAction SilentlyContinue
Remove-Item Env:DSH_PROFILE -ErrorAction SilentlyContinue
Remove-Item Env:DSH_PROFILE_DIR -ErrorAction SilentlyContinue
$env:DSH_HOME = $Sandbox

$name = (Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json).name
dsh plugin --profile web remove $name 2>$null
if ($LASTEXITCODE -ne 0) { $global:LASTEXITCODE = 0 }
dsh plugin --profile web add "file:$Root"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
dsh --profile web --no-open --port $Port
exit $LASTEXITCODE
