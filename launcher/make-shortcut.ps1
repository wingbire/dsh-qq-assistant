# 在桌面（和开始菜单）建一个带图标的快捷方式
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$exe  = Join-Path $PSScriptRoot "DSHQQTray.exe"
if (-not (Test-Path $exe)) { throw "先编译：" + $exe }

$ws = New-Object -ComObject WScript.Shell

function New-Lnk([string]$path, [string]$desc) {
  $lnk = $ws.CreateShortcut($path)
  $lnk.TargetPath       = $exe
  $lnk.WorkingDirectory = $PSScriptRoot
  $lnk.IconLocation     = $exe + ",0"
  $lnk.Description      = $desc
  $lnk.WindowStyle      = 7
  $lnk.Save()
  Write-Host ("已创建 " + $path)
}

$desktop = [Environment]::GetFolderPath("Desktop")
New-Lnk (Join-Path $desktop "DSH-QQ 群小助手.lnk") "DSH-QQ 群小助手 · 双击启动（托盘常驻，会顺带拉起 NapCat）"

$startMenu = Join-Path ([Environment]::GetFolderPath("Programs")) "DSH-QQ 群小助手.lnk"
try { New-Lnk $startMenu "DSH-QQ 群小助手" } catch { Write-Host ("开始菜单那份没建成：" + $_.Exception.Message) }
