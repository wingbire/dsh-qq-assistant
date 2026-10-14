# 把一张图片转成多尺寸 .ico（Vista+ 的 PNG 内嵌格式），只用 .NET 自带能力
param(
  [string]$Source = "$PSScriptRoot\..\好鲸鱼~.jpg",
  [string]$Out    = "$PSScriptRoot\DSHQQTray.ico"
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$src = [System.Drawing.Image]::FromFile((Resolve-Path $Source).Path)
try {
  # ICO 必须是正方形：从原图里取居中的正方形（竖直方向略偏上，脸在中间）
  $side = [Math]::Min($src.Width, $src.Height)
  $x = [int](($src.Width  - $side) / 2)
  $y = [int](($src.Height - $side) / 2)
  if ($src.Height -gt $src.Width) { $y = [int](($src.Height - $side) * 0.42) }
  Write-Host ("源图 " + $src.Width + "x" + $src.Height + "  →  裁 " + $side + "x" + $side + " (x=" + $x + ", y=" + $y + ")")

  $sizes = @(16, 24, 32, 48, 64, 128, 256)
  $blobs = New-Object System.Collections.ArrayList
  foreach ($s in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $rectDst = New-Object System.Drawing.Rectangle(0, 0, $s, $s)
    $g.DrawImage($src, $rectDst, $x, $y, $side, $side, [System.Drawing.GraphicsUnit]::Pixel)
    $g.Dispose()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $ms.ToArray()
    $ms.Dispose(); $bmp.Dispose()
    [void]$blobs.Add([pscustomobject]@{ Size = $s; Bytes = $bytes })
  }

  $fs = [System.IO.File]::Create($Out)
  $bw = New-Object System.IO.BinaryWriter($fs)
  try {
    $bw.Write([uint16]0)                     # reserved
    $bw.Write([uint16]1)                     # type = icon
    $bw.Write([uint16]$blobs.Count)          # count
    $offset = 6 + 16 * $blobs.Count
    foreach ($b in $blobs) {
      $bw.Write([byte]$(if ($b.Size -ge 256) { 0 } else { $b.Size }))   # width
      $bw.Write([byte]$(if ($b.Size -ge 256) { 0 } else { $b.Size }))   # height
      $bw.Write([byte]0)                     # colors
      $bw.Write([byte]0)                     # reserved
      $bw.Write([uint16]1)                   # planes
      $bw.Write([uint16]32)                  # bpp
      $bw.Write([uint32]$b.Bytes.Length)
      $bw.Write([uint32]$offset)
      $offset += $b.Bytes.Length
    }
    foreach ($b in $blobs) { $bw.Write($b.Bytes) }
  } finally { $bw.Flush(); $bw.Close(); $fs.Close() }
  Write-Host ("已生成 " + $Out + "  " + [math]::Round((Get-Item $Out).Length/1KB,1) + " KB  （" + ($sizes -join "/") + "）")
} finally { $src.Dispose() }
