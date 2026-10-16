$ErrorActionPreference='Stop'
$repoRoot=Split-Path $PSScriptRoot -Parent
$pgBin='C:/Program Files/PostgreSQL/17/bin'
if(!(Test-Path "$pgBin/initdb.exe")){throw 'Local PostgreSQL 17 required'}
$listener=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0); $listener.Start(); $port=$listener.LocalEndpoint.Port; $listener.Stop()
$testRoot=Join-Path ([System.IO.Path]::GetTempPath()) ('auth-session-pg-'+[guid]::NewGuid().ToString('N')); $dataDir=Join-Path $testRoot 'data'
New-Item -ItemType Directory -Path $testRoot | Out-Null
function Run-Pg($exe,$arguments){ & (Join-Path $pgBin $exe) @arguments; if($LASTEXITCODE -ne 0){throw "$exe failed"} }
$oldDb=$env:DATABASE_URL; $oldTest=$env:AUTH_LOCAL_TEST; $oldApp=$env:APP_URL; $started=$false
try {
 Run-Pg 'initdb.exe' @('-D',$dataDir,'-U','postgres','-A','trust','--encoding=UTF8','--locale=C')
 Run-Pg 'pg_ctl.exe' @('-D',$dataDir,'-l',(Join-Path $testRoot 'server.log'),'-o',"-h 127.0.0.1 -p $port",'-w','start'); $started=$true
 Run-Pg 'createdb.exe' @('-h','127.0.0.1','-p',"$port",'-U','postgres','session_test')
 Run-Pg 'psql.exe' @('-X','-h','127.0.0.1','-p',"$port",'-U','postgres','-d','session_test','-v','ON_ERROR_STOP=1','-f',(Join-Path $repoRoot 'artifacts/api-server/tests/schema.sql'))
 $env:DATABASE_URL="postgresql://postgres@127.0.0.1:$port/session_test"; $env:AUTH_LOCAL_TEST='1'; $env:APP_URL=''
 Push-Location (Join-Path $repoRoot 'artifacts/api-server')
 try { node ./tests/run.mjs; if($LASTEXITCODE -ne 0){throw 'Session tests failed'} } finally {Pop-Location}
} finally {
 $env:DATABASE_URL=$oldDb; $env:AUTH_LOCAL_TEST=$oldTest; $env:APP_URL=$oldApp
 if($started){Run-Pg 'pg_ctl.exe' @('-D',$dataDir,'-m','fast','-w','stop')}
 Write-Output "Local test cluster stopped; diagnostics: $testRoot"
}
