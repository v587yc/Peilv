[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('install', 'start', 'stop', 'status', 'bootstrap', 'health', 'backup')]
    [string]$Action = 'status',

    [string]$DataDirectory,
    [int]$ApiPort = 54321
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$InfraDirectory = Join-Path $ProjectRoot 'infra\local-data'
$ComposeFile = Join-Path $InfraDirectory 'compose.yml'
$EnvFile = Join-Path $InfraDirectory '.env'
$SetupSql = Join-Path $ProjectRoot 'setup-database.sql'
$RolesSql = Join-Path $InfraDirectory 'sql\roles.sql'
$DefaultDataDirectory = Join-Path $ProjectRoot '.local-data'
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

function Assert-Docker {
    Resolve-Docker
    Invoke-Native docker version --format '{{.Server.Version}}' | Out-Null
    Invoke-Native docker compose version | Out-Null
}

function ConvertTo-Base64Url {
    param([byte[]]$Bytes)
    return [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function New-Secret {
    param([int]$ByteCount = 48)
    $bytes = New-Object byte[] $ByteCount
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return ConvertTo-Base64Url $bytes
}

function New-Jwt {
    param([string]$Secret, [string]$Role)
    $utf8 = New-Object Text.UTF8Encoding($false)
    $header = ConvertTo-Base64Url ($utf8.GetBytes('{"alg":"HS256","typ":"JWT"}'))
    $payloadJson = '{"role":"' + $Role + '","iss":"peilv-local-data"}'
    $payload = ConvertTo-Base64Url ($utf8.GetBytes($payloadJson))
    $unsigned = "$header.$payload"
    $hmac = New-Object Security.Cryptography.HMACSHA256(,$utf8.GetBytes($Secret))
    try { $signature = ConvertTo-Base64Url ($hmac.ComputeHash($utf8.GetBytes($unsigned))) } finally { $hmac.Dispose() }
    return "$unsigned.$signature"
}

function ConvertTo-EnvPath {
    param([string]$Path)
    return ([IO.Path]::GetFullPath($Path)).Replace('\', '/')
}

function Read-LocalEnv {
    if (-not (Test-Path -LiteralPath $EnvFile)) { throw "Local data environment is not installed. Run: local-data.ps1 install" }
    $values = @{}
    foreach ($line in [IO.File]::ReadAllLines($EnvFile)) {
        if ($line -match '^([^#=]+)=(.*)$') { $values[$matches[1].Trim()] = $matches[2] }
    }
    return $values
}

function Get-LocalDatabaseName {
    $values = Read-LocalEnv
    if ($values.ContainsKey('POSTGRES_DB') -and $values['POSTGRES_DB']) { return $values['POSTGRES_DB'] }
    return 'peilv'
}

function Invoke-Compose {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    Invoke-Native docker compose --project-directory $InfraDirectory --env-file $EnvFile -f $ComposeFile @Arguments
}

function Wait-Postgres {
    $database = Get-LocalDatabaseName
    $deadline = (Get-Date).AddMinutes(2)
    do {
        & docker compose --project-directory $InfraDirectory --env-file $EnvFile -f $ComposeFile exec -T postgres pg_isready -U postgres -d $database 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { return }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)
    throw 'PostgreSQL did not become healthy within two minutes.'
}

function Test-LocalApi {
    $values = Read-LocalEnv
    $port = $values['LOCAL_API_PORT']
    $headers = @{
        apikey = $values['SERVICE_ROLE_KEY']
        Authorization = 'Bearer ' + $values['SERVICE_ROLE_KEY']
    }
    $deadline = (Get-Date).AddMinutes(1)
    do {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/rest/v1/health_check?select=id&limit=1" -Headers $headers -TimeoutSec 5
            if ($response.StatusCode -eq 200) { return }
        } catch {
            Start-Sleep -Seconds 2
        }
    } while ((Get-Date) -lt $deadline)
    throw 'The local PostgREST gateway did not become healthy within one minute.'
}

function Invoke-PsqlFile {
    param([string]$Path, [string]$Prefix = '')
    $content = $Prefix + [IO.File]::ReadAllText($Path)
    $database = Get-LocalDatabaseName
    $content | & docker compose --project-directory $InfraDirectory --env-file $EnvFile -f $ComposeFile exec -T postgres psql -X --set ON_ERROR_STOP=1 -U postgres -d $database
    if ($LASTEXITCODE -ne 0) { throw "Database script failed: $Path" }
}

function Invoke-Bootstrap {
    $envValues = Read-LocalEnv
    Wait-Postgres
    Invoke-PsqlFile $SetupSql
    $escapedPassword = $envValues['AUTHENTICATOR_PASSWORD'].Replace("'", "''")
    Invoke-PsqlFile $RolesSql ("\set authenticator_password '" + $escapedPassword + "'`n")

    $requiredTables = @('schema_migrations','health_check','prediction_data','match_odds','daily_reports','prediction_results','prediction_results_backtest','learned_patterns','learned_patterns_backtest','strategy_versions','app_settings','memory_bank','league_selections','user_focused_leagues','backtest_jobs','automation_tasks','automation_task_steps','odds_snapshots','data_quality_records','audit_logs','migration_duplicate_archive')
    $tableList = ($requiredTables | ForEach-Object { "'$_'" }) -join ','
    $validation = "DO `$`$ BEGIN IF (SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename IN ($tableList)) <> $($requiredTables.Count) THEN RAISE EXCEPTION 'required tables are missing'; END IF; IF NOT EXISTS (SELECT 1 FROM schema_migrations) THEN RAISE EXCEPTION 'schema_migrations is empty'; END IF; IF to_regprocedure('public.upsert_match_odds_if_fresher(text,text,text,jsonb,jsonb,jsonb,jsonb,text,timestamp with time zone,text)') IS NULL THEN RAISE EXCEPTION 'upsert_match_odds_if_fresher is missing'; END IF; END `$`$;"
    $database = Get-LocalDatabaseName
    $validation | & docker compose --project-directory $InfraDirectory --env-file $EnvFile -f $ComposeFile exec -T postgres psql -X --set ON_ERROR_STOP=1 -U postgres -d $database | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Bootstrap validation failed.' }
    Write-Output 'Local database bootstrap and validation completed.'
}

function Install-LocalData {
    Assert-Docker
    if (Test-Path -LiteralPath $EnvFile) {
        Write-Output 'Local data environment already exists; secrets were left unchanged.'
        return
    }
    $resolvedDataDirectory = if ($DataDirectory) { [IO.Path]::GetFullPath($DataDirectory) } else { $DefaultDataDirectory }
    New-Item -ItemType Directory -Force -Path (Join-Path $resolvedDataDirectory 'postgres') | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $resolvedDataDirectory 'backups') | Out-Null
    $jwtSecret = New-Secret 64
    $lines = @(
        'POSTGRES_DB=peilv',
        ('POSTGRES_PASSWORD=' + (New-Secret 48)),
        ('AUTHENTICATOR_PASSWORD=' + (New-Secret 48)),
        ('JWT_SECRET=' + $jwtSecret),
        ('ANON_KEY=' + (New-Jwt $jwtSecret 'anon')),
        ('SERVICE_ROLE_KEY=' + (New-Jwt $jwtSecret 'service_role')),
        ('LOCAL_API_PORT=' + $ApiPort),
        ('PEILV_LOCAL_DATA_DIR=' + (ConvertTo-EnvPath $resolvedDataDirectory))
    )
    [IO.File]::WriteAllLines($EnvFile, $lines, (New-Object Text.UTF8Encoding($false)))
    Write-Output "Local data configuration installed at $EnvFile. Secrets were generated but are not displayed."
}

function Backup-LocalData {
    $envValues = Read-LocalEnv
    Wait-Postgres
    $backupDirectory = Join-Path $envValues['PEILV_LOCAL_DATA_DIR'] 'backups'
    New-Item -ItemType Directory -Force -Path $backupDirectory | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $dumpPath = Join-Path $backupDirectory "peilv-$stamp.dump"
    $manifestPath = "$dumpPath.manifest.json"
    $database = Get-LocalDatabaseName
    $containerId = (& docker compose --project-directory $InfraDirectory --env-file $EnvFile -f $ComposeFile ps -q postgres).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $containerId) { throw 'Could not identify the local PostgreSQL container.' }
    $containerDump = "/tmp/peilv-$stamp.dump"
    try {
        Invoke-Native docker exec $containerId pg_dump -U postgres -d $database --format=custom --no-owner --no-acl --file=$containerDump
        Invoke-Native docker cp "${containerId}:${containerDump}" $dumpPath
    } finally {
        & docker exec $containerId rm -f $containerDump 2>$null | Out-Null
    }
    & docker run --rm -v "${backupDirectory}:/backup:ro" $PostgresImage pg_restore --list "/backup/$([IO.Path]::GetFileName($dumpPath))" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Backup validation with pg_restore --list failed.' }
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $dumpPath).Hash.ToLowerInvariant()
    $manifest = [ordered]@{ format = 'pg_dump-custom'; database = $database; created_at_utc = [DateTime]::UtcNow.ToString('o'); file = [IO.Path]::GetFileName($dumpPath); bytes = (Get-Item -LiteralPath $dumpPath).Length; sha256 = $hash; postgres_image = $PostgresImage }
    $manifest | ConvertTo-Json | Set-Content -LiteralPath $manifestPath -Encoding UTF8
    Write-Output "Backup created: $dumpPath"
    Write-Output "Manifest created: $manifestPath"
}

switch ($Action) {
    'install' { Install-LocalData }
    'start' { Assert-Docker; if (-not (Test-Path $EnvFile)) { Install-LocalData }; Invoke-Compose up -d; Invoke-Bootstrap; Test-LocalApi; Write-Output 'Local PostgreSQL and PostgREST are healthy.' }
    'stop' { Assert-Docker; Read-LocalEnv | Out-Null; Invoke-Compose stop; Write-Output 'Services stopped. Local data and volumes were preserved.' }
    'status' { Assert-Docker; Read-LocalEnv | Out-Null; Invoke-Compose ps }
    'bootstrap' { Assert-Docker; Invoke-Bootstrap }
    'health' { Assert-Docker; Read-LocalEnv | Out-Null; Wait-Postgres; Test-LocalApi; Invoke-Compose ps; Write-Output 'PostgreSQL and PostgREST are healthy.' }
    'backup' { Assert-Docker; Backup-LocalData }
}
