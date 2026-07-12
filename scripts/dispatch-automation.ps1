$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $projectRoot ".env"
$secretLine = Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^INTERNAL_API_SECRET=' } | Select-Object -Last 1
if (-not $secretLine) {
    throw "INTERNAL_API_SECRET is not configured"
}

$secret = $secretLine.Substring("INTERNAL_API_SECRET=".Length).Trim()
if (-not $secret) {
    throw "INTERNAL_API_SECRET is empty"
}

$headers = @{
    "Content-Type" = "application/json"
    "x-internal-api-secret" = $secret
}

$response = Invoke-RestMethod `
    -Method Post `
    -Uri "http://127.0.0.1:5000/api/automation/dispatch" `
    -Headers $headers `
    -Body '{"maxTasks":1}' `
    -TimeoutSec 300

if (-not $response.success) {
    throw "Automation dispatch failed"
}
