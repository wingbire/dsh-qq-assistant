$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$icoPath = "$PSScriptRoot\DSHQQTray.ico"
$ico = New-Object System.Drawing.Icon($icoPath)
Write-Host ("图标可加载，默认帧 " + $ico.Width + "x" + $ico.Height)
$ico.Dispose()

$b = New-Object System.IO.BinaryReader([System.IO.File]::OpenRead($icoPath))
[void]$b.ReadBytes(4)
$count = $b.ReadUInt16()
$entries = @()
for ($i = 0; $i -lt $count; $i++) {
  $w = $b.ReadByte(); $h = $b.ReadByte()
  [void]$b.ReadBytes(2); [void]$b.ReadBytes(4)
  $len = $b.ReadUInt32(); $off = $b.ReadUInt32()
  $entries += [pscustomobject]@{ W = $(if ($w -eq 0) { 256 } else { $w }); Len = $len; Off = $off }
}
$b.Close()
Write-Host ("共 " + $count + " 帧：")
foreach ($e in $entries) { Write-Host ("  " + $e.W + "x" + $e.W + "   " + [math]::Round($e.Len / 1KB, 1) + " KB") }

$last = $entries[$entries.Count - 1]
$fs = [System.IO.File]::OpenRead($icoPath)
[void]$fs.Seek($last.Off, "Begin")
$buf = New-Object byte[] $last.Len
[void]$fs.Read($buf, 0, $last.Len)
$fs.Close()
$outPng = "$PSScriptRoot\..\app\dsh-data\_probe\icon-preview.png"
New-Item -ItemType Directory -Force -Path (Split-Path $outPng) | Out-Null
[System.IO.File]::WriteAllBytes($outPng, $buf)
$img = [System.Drawing.Image]::FromFile((Resolve-Path $outPng).Path)
Write-Host ("导出预览 " + $img.Width + "x" + $img.Height + " -> " + $outPng)
$img.Dispose()
