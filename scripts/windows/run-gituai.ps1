$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $RepoRoot

if (-not (Test-Path (Join-Path $RepoRoot "package.json"))) {
  throw "package.json not found at repo root: $RepoRoot"
}

npm start

