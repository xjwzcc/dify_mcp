$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$runtimeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodeExecutable = if ($runtimeCommand) { $runtimeCommand.Source } else { Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
if (-not (Test-Path -LiteralPath $nodeExecutable)) { throw 'Node.js 24 is required: https://nodejs.org/' }
try { $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/api/health' -TimeoutSec 2 } catch { $health = $null }
if ($health.product -ne 'hotel-hr-v2') {
  $serverFile = Join-Path $PSScriptRoot 'server.cjs'
  $processInfo = Start-Process -FilePath $nodeExecutable -ArgumentList @('"' + $serverFile + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot 'server.log') -RedirectStandardError (Join-Path $PSScriptRoot 'server-error.log') -PassThru
  $processInfo.Id | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'server.pid')
  for ($attempt=0; $attempt -lt 20; $attempt++) { Start-Sleep -Milliseconds 250; try { $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/api/health' -TimeoutSec 1; if ($health.ok) { break } } catch {} }
  if (-not $health.ok) { throw 'Startup failed. Read server-error.log.' }
}
Write-Host 'Hotel HR is running: http://localhost:8787' -ForegroundColor Green
$localAddresses = [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName())
foreach ($localAddress in $localAddresses) { if ($localAddress.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and -not [System.Net.IPAddress]::IsLoopback($localAddress)) { Write-Host ('LAN URL: http://' + $localAddress.IPAddressToString + ':8787') } }
Write-Host 'Keep this computer powered on. Student records are stored in data/hotel.sqlite.'
