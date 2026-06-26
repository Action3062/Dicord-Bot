$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodePath = if ($nodeCommand) { $nodeCommand.Source } else { $null }

if (!$nodePath) {
  Write-Host "Node.js wurde nicht gefunden. Installiere Node.js und fuehre danach npm install aus."
  exit 1
}

$envPath = Join-Path $Root ".env"
if (!(Test-Path $envPath)) {
  Write-Host ".env fehlt. Kopiere .env.example nach .env und trage DISCORD_TOKEN ein."
  exit 1
}

Get-Content $envPath | ForEach-Object {
  $line = $_.Trim()
  if (!$line -or $line.StartsWith("#") -or $line -notmatch "=") {
    return
  }
  $parts = $line -split "=", 2
  $name = $parts[0].Trim()
  $value = $parts[1].Trim()
  if ($name) {
    Set-Item -Path "Env:$name" -Value $value
  }
}

if (!$env:DISCORD_TOKEN) {
  Write-Host "DISCORD_TOKEN fehlt in .env."
  exit 1
}

if (!$env:BOT_DATA_DIR) {
  $env:BOT_DATA_DIR = Join-Path $Root "data"
}
New-Item -ItemType Directory -Force -Path $env:BOT_DATA_DIR | Out-Null

$botEntry = Join-Path $Root "dist\index.js"
if (!(Test-Path $botEntry)) {
  Write-Host "dist\index.js fehlt. Fuehre zuerst npm install und npm run build aus."
  exit 1
}

Write-Host "Jellyfin Discord Bot startet. Dieses Fenster offen lassen. Stoppen mit Strg+C."
& $nodePath $botEntry
