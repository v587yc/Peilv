param(
    [switch]$IncludeDevDependencies
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot

if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
    throw "Node.js is not installed or node.exe is not available in PATH"
}

if (-not (Get-Command pnpm.cmd -ErrorAction SilentlyContinue)) {
    $corepack = Get-Command corepack.cmd -ErrorAction SilentlyContinue
    if (-not $corepack) {
        throw "pnpm is not installed and corepack.cmd is not available"
    }

    & $corepack.Source enable
    & $corepack.Source prepare pnpm@9.0.0 --activate
}

Push-Location $projectRoot
try {
    if ($IncludeDevDependencies) {
        & pnpm.cmd install --frozen-lockfile
    } else {
        & pnpm.cmd install --prod --frozen-lockfile
    }

    if ($LASTEXITCODE -ne 0) {
        throw "Dependency installation failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}

Write-Output "production-dependencies-installed"
