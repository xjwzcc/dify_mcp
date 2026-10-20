$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCommand) { $nodePath = $nodeCommand.Source }
else {
  $nodePath = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
  if (-not (Test-Path -LiteralPath $nodePath)) { throw '请先安装 Node.js 24 或更新版本，再运行本系统。' }
}
Write-Host '教师端 http://localhost:8791/teacher'
Write-Host '学生端 http://localhost:8791/student'
Write-Host '教师密码请查看 data/login.json。局域网教学请使用本机IPv4地址替换localhost。'
& $nodePath (Join-Path $PSScriptRoot 'server.cjs')
