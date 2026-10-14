# 把 dist\<包名> 打成扁平结构的 zip（内容在根，解压即用）
# 为什么不放在 build-package.mjs 里：Node 侧写 zip 要额外依赖，PowerShell 自带即可。
param(
  [string]$Name = "DSHQQ-Assistant-3.0.0"
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = Join-Path $here $Name
$zip = Join-Path $here ($Name + ".zip")
if (-not (Test-Path $src)) { throw "先跑 build-package.mjs 生成 $src" }
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (Test-Path $zip) { Remove-Item $zip -Force }
[System.IO.Compression.ZipFile]::CreateFromDirectory($src, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $false)
$kb = [math]::Round((Get-Item $zip).Length / 1KB, 1)
Write-Host "已生成 $zip（$kb KB）"
