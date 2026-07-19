param(
    [string]$OutputPath
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"

if (-not $OutputPath) {
    $OutputPath = Join-Path (Split-Path -Parent $projectRoot) "peilv-distribution-$timestamp.zip"
} elseif (-not [IO.Path]::IsPathRooted($OutputPath)) {
    $OutputPath = Join-Path (Get-Location) $OutputPath
}

$OutputPath = [IO.Path]::GetFullPath($OutputPath)
$outputDirectory = Split-Path -Parent $OutputPath
$requiredPaths = @(
    ".env",
    ".next\server",
    ".next\static",
    "dist\server.js",
    "package.json",
    "pnpm-lock.yaml",
    "setup-database.sql",
    "migrations\0001_production_baseline.sql",
    "scripts\reconcile-automation.ps1",
    "scripts\reconcile-automation.sh",
    "infra\systemd\peilv-reconcile.service",
    "infra\systemd\peilv-reconcile.timer"
)

foreach ($relativePath in $requiredPaths) {
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot $relativePath))) {
        throw "Required distribution path is missing: $relativePath"
    }
}

$includedDirectories = @(
    ".next",
    "assets",
    "data",
    "dist",
    "infra",
    "migrations",
    "public",
    "scripts",
    "src",
    "tests"
)
$excludedPrefixes = @(
    ".next\cache\",
    ".next\dev\",
    ".next\diagnostics\",
    ".next\types\",
    ".local-data\",
    "infra\local-data\.env"
)
$excludedFileNames = @(
    "server.log",
    "tsconfig.tsbuildinfo"
)
$excludedExtensions = @(
    ".log",
    ".tmp",
    ".temp",
    ".zip",
    ".gz",
    ".tar",
    ".tgz",
    ".dump",
    ".backup"
)

$stagingRoot = Join-Path ([IO.Path]::GetTempPath()) "peilv-distribution-$([guid]::NewGuid().ToString('N'))"
$packageRoot = Join-Path $stagingRoot "peilv"

function Get-RelativeProjectPath {
    param([string]$SourcePath)

    $fullRoot = [IO.Path]::GetFullPath($projectRoot).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $fullSource = [IO.Path]::GetFullPath($SourcePath)
    $rootPrefix = $fullRoot + [IO.Path]::DirectorySeparatorChar
    if (-not $fullSource.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        return $null
    }

    return $fullSource.Substring($rootPrefix.Length)
}

function Copy-DistributionFile {
    param([string]$SourcePath)

    $relativePath = Get-RelativeProjectPath -SourcePath $SourcePath
    if (-not $relativePath) {
        return
    }

    foreach ($prefix in $excludedPrefixes) {
        if ($relativePath.StartsWith($prefix, $true, [Globalization.CultureInfo]::InvariantCulture)) {
            return
        }
    }

    $fileName = [IO.Path]::GetFileName($relativePath)
    if ($excludedFileNames -contains $fileName) {
        return
    }

    $extension = [IO.Path]::GetExtension($fileName)
    if ($excludedExtensions -contains $extension) {
        return
    }

    $destinationPath = Join-Path $packageRoot $relativePath
    $destinationDirectory = Split-Path -Parent $destinationPath
    New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
    Copy-Item -LiteralPath $SourcePath -Destination $destinationPath -Force
}

try {
    New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null

    Get-ChildItem -LiteralPath $projectRoot -File -Force | ForEach-Object {
        Copy-DistributionFile -SourcePath $_.FullName
    }

    foreach ($directory in $includedDirectories) {
        $sourceDirectory = Join-Path $projectRoot $directory
        if (Test-Path -LiteralPath $sourceDirectory -PathType Container) {
            Get-ChildItem -LiteralPath $sourceDirectory -File -Recurse -Force | ForEach-Object {
                Copy-DistributionFile -SourcePath $_.FullName
            }
        }
    }

    foreach ($relativePath in $requiredPaths) {
        if (-not (Test-Path -LiteralPath (Join-Path $packageRoot $relativePath))) {
            throw "Required path was not copied: $relativePath"
        }
    }

    New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
    if (Test-Path -LiteralPath $OutputPath) {
        Remove-Item -LiteralPath $OutputPath -Force
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory(
        $packageRoot,
        $OutputPath,
        [IO.Compression.CompressionLevel]::Optimal,
        $true
    )

    $archive = [IO.Compression.ZipFile]::OpenRead($OutputPath)
    try {
        $entryNames = @($archive.Entries | ForEach-Object { $_.FullName.Replace('/', '\') })
        $requiredEntries = @(
            "peilv\.env",
            "peilv\dist\server.js",
            "peilv\package.json",
            "peilv\pnpm-lock.yaml",
            "peilv\setup-database.sql",
            "peilv\scripts\install-production.ps1",
            "peilv\scripts\register-windows-tasks.ps1",
            "peilv\scripts\reconcile-automation.ps1",
            "peilv\scripts\reconcile-automation.sh",
            "peilv\infra\systemd\peilv-reconcile.service",
            "peilv\infra\systemd\peilv-reconcile.timer"
        )

        foreach ($entry in $requiredEntries) {
            if ($entryNames -notcontains $entry) {
                throw "Required archive entry is missing: $entry"
            }
        }

        $forbiddenPatterns = @(
            "\node_modules\",
            "\.next\cache\",
            "\.next\dev\",
            "\.next\diagnostics\",
            "\.next\types\",
            "\.local-data\",
            "\infra\local-data\.env"
        )
        foreach ($entryName in $entryNames) {
            foreach ($pattern in $forbiddenPatterns) {
                if ($entryName.IndexOf($pattern, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
                    throw "Forbidden archive entry detected: $entryName"
                }
            }
        }

        $fileCount = @($archive.Entries | Where-Object { -not $_.FullName.EndsWith('/') }).Count
    } finally {
        $archive.Dispose()
    }

    $archiveFile = Get-Item -LiteralPath $OutputPath
    $hash = Get-FileHash -LiteralPath $OutputPath -Algorithm SHA256
    Write-Output "PACKAGE_PATH=$($archiveFile.FullName)"
    Write-Output "PACKAGE_SIZE=$($archiveFile.Length)"
    Write-Output "PACKAGE_FILES=$fileCount"
    Write-Output "PACKAGE_SHA256=$($hash.Hash)"
} finally {
    if (Test-Path -LiteralPath $stagingRoot) {
        Remove-Item -LiteralPath $stagingRoot -Recurse -Force
    }
}
