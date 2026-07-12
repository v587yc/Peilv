[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('online-to-local', 'local-to-online')]
    [string]$Action,

    [switch]$WritersStopped,
    [string]$BackupDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$InfraDirectory = Join-Path $ProjectRoot 'infra\local-data'
$ComposeFile = Join-Path $InfraDirectory 'compose.yml'
$EnvFile = Join-Path $InfraDirectory '.env'
$RolesSql = Join-Path $InfraDirectory 'sql\roles.sql'
$PostgresImage = 'postgres:15.8-alpine'

function Invoke-Native {
    param([Parameter(Mandatory = $true)][string]$Command, [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Command failed with exit code ${LASTEXITCODE}: $Command" }
}

function Resolve-Docker {
    if (Get-Command docker -ErrorAction SilentlyContinue) { return }
    $dockerDirectory = Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin'
    $dockerExecutable = Join-Path $dockerDirectory 'docker.exe'
    if (-not (Test-Path -LiteralPath $dockerExecutable)) { throw 'Docker is required and was not found in PATH or the default Docker Desktop location.' }
    $env:Path = "$dockerDirectory;$env:Path"
}

function Assert-Prerequisites {
    if (-not $WritersStopped) { throw 'Refusing cutover. Stop all database writers, then rerun with -WritersStopped.' }
    Resolve-Docker
    Invoke-Native docker version --format '{{.Server.Version}}' | Out-Null
    if (-not (Test-Path -LiteralPath $EnvFile)) { throw 'Local data is not installed; infra/local-data/.env is missing.' }
}

function Read-EnvFile {
    $values = @{}
    foreach ($line in [IO.File]::ReadAllLines($EnvFile)) {
        if ($line -match '^([^#=]+)=(.*)$') { $values[$matches[1].Trim()] = $matches[2] }
    }
    return $values
}

function Get-ComposeProjectName {
    $name = Split-Path -Leaf $InfraDirectory
    return ($name.ToLowerInvariant() -replace '[^a-z0-9_-]', '')
}

function Get-LocalNetwork {
    $project = Get-ComposeProjectName
    $network = & docker network ls --filter "label=com.docker.compose.project=$project" --format '{{.Name}}' | Select-Object -First 1
    if ($LASTEXITCODE -ne 0 -or -not $network) { throw 'The local Docker Compose network was not found. Start local data first.' }
    return $network.Trim()
}

function Invoke-ImageDatabaseCommand {
    param(
        [ValidateSet('url', 'local')][string]$Connection,
        [string]$Script,
        [string]$Url,
        [string]$MountDirectory,
        [switch]$Capture
    )
    $args = @('run', '--rm', '-i')
    if ($MountDirectory) { $args += @('-v', (([IO.Path]::GetFullPath($MountDirectory)).Replace('\','/') + ':/transfer')) }
    if ($Connection -eq 'url') {
        $old = $env:DATABASE_URL
        $env:DATABASE_URL = $Url
        $args += @('-e', 'DATABASE_URL')
    } else {
        $local = Read-EnvFile
        $oldPassword = $env:PGPASSWORD
        $env:PGPASSWORD = $local['POSTGRES_PASSWORD']
        $args += @('--network', (Get-LocalNetwork), '-e', 'PGPASSWORD', '-e', 'PGHOST=postgres', '-e', 'PGUSER=postgres', '-e', ('PGDATABASE=' + $local['POSTGRES_DB']))
    }
    $args += @($PostgresImage, 'sh', '-ceu', $Script)
    try {
        if ($Capture) {
            $output = & docker @args
            if ($LASTEXITCODE -ne 0) { throw "Database command failed with exit code $LASTEXITCODE." }
            return @($output)
        }
        Invoke-Native docker @args
    } finally {
        if ($Connection -eq 'url') { $env:DATABASE_URL = $old }
        else { $env:PGPASSWORD = $oldPassword }
    }
}

function Get-DatabaseSnapshot {
    param([string]$Connection, [string]$Url)
    $sql = @"
SELECT format('SELECT %L || ''|'' || count(*)::text FROM public.%I;', tablename, tablename)
FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
\gexec
SELECT 'schema_versions|' || COALESCE(string_agg(version, ',' ORDER BY version), '') FROM public.schema_migrations;
"@
    $escaped = $sql.Replace("'", "'\''")
    $script = if ($Connection -eq 'url') { "printf '%s' '$escaped' | psql -X -v ON_ERROR_STOP=1 -Atq `"`$DATABASE_URL`"" } else { "printf '%s' '$escaped' | psql -X -v ON_ERROR_STOP=1 -Atq" }
    $lines = Invoke-ImageDatabaseCommand -Connection $Connection -Url $Url -Script $script -Capture
    $snapshot = [ordered]@{}
    foreach ($line in $lines) {
        if ($line -match '^([^|]+)\|(.*)$') { $snapshot[$matches[1]] = $matches[2] }
    }
    return $snapshot
}

function Assert-SnapshotsEqual {
    param($Source, $Destination)
    $differences = New-Object Collections.Generic.List[string]
    foreach ($key in $Source.Keys) {
        if (-not $Destination.Contains($key)) { $differences.Add("missing destination table: $key") }
        elseif ([string]$Source[$key] -ne [string]$Destination[$key]) { $differences.Add("$key source=$($Source[$key]) destination=$($Destination[$key])") }
    }
    foreach ($key in $Destination.Keys) { if (-not $Source.Contains($key)) { $differences.Add("unexpected destination table: $key") } }
    if ($differences.Count -gt 0) { throw ('Post-restore comparison failed: ' + ($differences -join '; ')) }
}

function Assert-DestinationEmpty {
    param([string]$Url)
    $script = 'count=$(psql -X -v ON_ERROR_STOP=1 -Atq "$DATABASE_URL" -c "SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=''public'' AND c.relkind IN (''r'',''p'',''v'',''m'',''S'',''f'')) + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=''public'')"); test "$count" = 0'
    Invoke-ImageDatabaseCommand -Connection url -Url $Url -Script $script
}

function Write-Manifest {
    param([string]$DumpPath, [string]$Direction, $SourceSnapshot, $DestinationSnapshot)
    $manifestPath = "$DumpPath.manifest.json"
    $manifest = [ordered]@{
        direction = $Direction
        format = 'pg_dump-custom'
        created_at_utc = [DateTime]::UtcNow.ToString('o')
        file = [IO.Path]::GetFileName($DumpPath)
        bytes = (Get-Item -LiteralPath $DumpPath).Length
        sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $DumpPath).Hash.ToLowerInvariant()
        postgres_image = $PostgresImage
        source_snapshot = $SourceSnapshot
        destination_snapshot = $DestinationSnapshot
    }
    $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
    Write-Output "Cutover completed. Dump: $DumpPath"
    Write-Output "Manifest: $manifestPath"
    if ($Direction -eq 'online-to-local') {
        Write-Output "Set DATA_BACKEND=local and LOCAL_SUPABASE_URL=http://127.0.0.1:$($localEnv['LOCAL_API_PORT']); copy ANON_KEY/SERVICE_ROLE_KEY from infra/local-data/.env to LOCAL_SUPABASE_ANON_KEY/LOCAL_SUPABASE_SERVICE_ROLE_KEY, then restart the application."
    } else {
        Write-Output 'Set DATA_BACKEND=online with the new Supabase endpoint credentials, then restart the application. Keep the local backup until online verification is complete.'
    }
}

Assert-Prerequisites
$localEnv = Read-EnvFile
if (-not $BackupDirectory) { $BackupDirectory = Join-Path $localEnv['PEILV_LOCAL_DATA_DIR'] 'backups\cutover' }
New-Item -ItemType Directory -Force -Path $BackupDirectory | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dumpPath = Join-Path ([IO.Path]::GetFullPath($BackupDirectory)) "$Action-$stamp.dump"
$dumpName = [IO.Path]::GetFileName($dumpPath)

if ($Action -eq 'online-to-local') {
    $sourceUrl = [Environment]::GetEnvironmentVariable('ONLINE_DATABASE_URL')
    if ([string]::IsNullOrWhiteSpace($sourceUrl)) { throw 'ONLINE_DATABASE_URL is required for online-to-local.' }
    $sourceSnapshot = Get-DatabaseSnapshot -Connection url -Url $sourceUrl
    Invoke-ImageDatabaseCommand -Connection url -Url $sourceUrl -MountDirectory $BackupDirectory -Script "pg_dump --format=custom --no-owner --no-acl --schema=public --file=/transfer/$dumpName `"`$DATABASE_URL`""
    Invoke-ImageDatabaseCommand -Connection local -MountDirectory $BackupDirectory -Script "pg_restore --list /transfer/$dumpName >/dev/null"
    & (Join-Path $PSScriptRoot 'local-data.ps1') backup
    Invoke-ImageDatabaseCommand -Connection local -MountDirectory $BackupDirectory -Script "pg_restore --exit-on-error --clean --if-exists --no-owner --no-acl --dbname=`"`$PGDATABASE`" /transfer/$dumpName"

    $password = $localEnv['AUTHENTICATOR_PASSWORD'].Replace("'", "''")
    $rolesPrefix = "\set authenticator_password '$password'`n"
    $rolesContent = $rolesPrefix + [IO.File]::ReadAllText($RolesSql)
    $rolesContent | & docker compose --project-directory $InfraDirectory --env-file $EnvFile -f $ComposeFile exec -T postgres psql -X --set ON_ERROR_STOP=1 -U postgres -d $localEnv['POSTGRES_DB'] | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Reapplying local roles failed.' }
    $destinationSnapshot = Get-DatabaseSnapshot -Connection local
} else {
    $targetUrl = [Environment]::GetEnvironmentVariable('TARGET_DATABASE_URL')
    if ([string]::IsNullOrWhiteSpace($targetUrl)) { throw 'TARGET_DATABASE_URL is required for local-to-online.' }
    Assert-DestinationEmpty -Url $targetUrl
    $sourceSnapshot = Get-DatabaseSnapshot -Connection local
    Invoke-ImageDatabaseCommand -Connection local -MountDirectory $BackupDirectory -Script "pg_dump --format=custom --no-owner --no-acl --schema=public --file=/transfer/$dumpName"
    Invoke-ImageDatabaseCommand -Connection url -Url $targetUrl -MountDirectory $BackupDirectory -Script "pg_restore --list /transfer/$dumpName >/dev/null"
    Invoke-ImageDatabaseCommand -Connection url -Url $targetUrl -MountDirectory $BackupDirectory -Script "pg_restore --exit-on-error --no-owner --no-acl --dbname=`"`$DATABASE_URL`" /transfer/$dumpName"
    $destinationSnapshot = Get-DatabaseSnapshot -Connection url -Url $targetUrl
}

Assert-SnapshotsEqual -Source $sourceSnapshot -Destination $destinationSnapshot
Write-Manifest -DumpPath $dumpPath -Direction $Action -SourceSnapshot $sourceSnapshot -DestinationSnapshot $destinationSnapshot
