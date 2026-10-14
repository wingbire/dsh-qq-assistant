# 编译托盘启动器（用 Windows 自带的 .NET Framework csc，不需要装任何 SDK）
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { $csc = "C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe" }
if (-not (Test-Path $csc)) { throw "找不到 csc.exe（需要 .NET Framework 4.x）" }
# 编译前先停掉正在跑的托盘：exe 被占用就写不进去
$running = @(Get-Process DSHQQTray -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
  Write-Host ("停掉正在运行的 " + $running.Count + " 个托盘实例（不然 exe 被占用）")
  foreach ($p in $running) { try { Stop-Process -Id $p.Id -Force -ErrorAction Stop } catch { } }
  Start-Sleep -Milliseconds 800
}

$ico = "$here\DSHQQTray.ico"
$icoArg = @()
if (Test-Path $ico) { $icoArg = @("/win32icon:$ico") } else { Write-Host "提示：没有 DSHQQTray.ico，先跑 make-icon.ps1 生成" }

& $csc /nologo /target:winexe /codepage:65001 /optimize+ `
  /out:"$here\DSHQQTray.exe" `
  /r:System.Windows.Forms.dll /r:System.Drawing.dll `
  $icoArg `
  "$here\DSHQQTray.cs"
if ($LASTEXITCODE -ne 0) { throw "编译失败（exit $LASTEXITCODE）" }
Write-Host "已生成 $here\DSHQQTray.exe"
