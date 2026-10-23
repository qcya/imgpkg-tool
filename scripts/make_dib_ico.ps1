$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$Src = 'c:\Users\Administrator\Desktop\imgpkg-tool\electron\resources\icon.png'
$Out = 'c:\Users\Administrator\Desktop\imgpkg-tool\electron\resources\icon.ico'

$srcImg = [System.Drawing.Image]::FromFile($Src)
$big = New-Object System.Drawing.Bitmap 256,256,([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($big)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
$g.Clear([System.Drawing.Color]::Transparent)
$g.DrawImage($srcImg, 0, 0, 256, 256)
$g.Dispose()

function MakeDibFrame([int]$s) {
  $bmp = New-Object System.Drawing.Bitmap $s,$s,([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $gg = [System.Drawing.Graphics]::FromImage($bmp)
  $gg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $gg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $gg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $gg.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $gg.Clear([System.Drawing.Color]::Transparent)
  $gg.DrawImage($big, 0, 0, $s, $s)
  $gg.Dispose()

  $rect = New-Object System.Drawing.Rectangle 0,0,$s,$s
  $data = $bmp.LockBits($rect,[System.Drawing.Imaging.ImageLockMode]::ReadOnly,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $stride = $data.Stride
  $ppRow = [Math]::Abs($stride)
  $rowBytes = $s * 4
  $buf = New-Object byte[] ($ppRow * $s)
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0,$buf,0,$buf.Length)
  $bmp.UnlockBits($data)
  $bmp.Dispose()

  $xorData = New-Object byte[] ($s*$rowBytes)   # XOR(BGRA) 自下而上
  for ($y=0; $y -lt $s; $y++) {
    $srcRow = if ($stride -gt 0) { ($s-1-$y)*$ppRow } else { $y*$ppRow }  # 翻转为 bottom-up
    [System.Array]::Copy($buf, $srcRow, $xorData, $y*$rowBytes, $rowBytes)
  }

  $andRow = ([int][Math]::Ceiling($s/32.0))*4
  $and = New-Object byte[] ($andRow*$s)

  $ms = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($ms)
  $bw.Write([uint32]40)
  $bw.Write([int32]$s)
  $bw.Write([int32]($s*2))
  $bw.Write([uint16]1)
  $bw.Write([uint16]32)
  $bw.Write([uint32]0)
  $bw.Write([uint32]($xorData.Length+$and.Length))
  $bw.Write([int32]0); $bw.Write([int32]0)
  $bw.Write([uint32]0); $bw.Write([uint32]0)
  $bw.Write($xorData)
  $bw.Write($and)
  $bw.Flush()
  $frame = $ms.ToArray()
  $bw.Dispose(); $ms.Dispose()
  return ,$frame
}

$sizes = @(16,24,32,40,48,64,128,256)
$frames = @()
foreach ($s in $sizes) { $frames += ,(MakeDibFrame $s) }

$count = $sizes.Count
$headerLen = 6 + $count * 16
$ico = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ico)
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$count)
$offset = $headerLen
for ($i=0; $i -lt $count; $i++) {
  $s = $sizes[$i]
  $wb = if ($s -ge 256) {0} else {$s}
  $bw.Write([byte]$wb); $bw.Write([byte]$wb)
  $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([uint16]1); $bw.Write([uint16]32)
  $bw.Write([uint32]$frames[$i].Length)
  $bw.Write([uint32]$offset)
  $offset += $frames[$i].Length
}
for ($i=0; $i -lt $count; $i++) { $bw.Write($frames[$i]) }
$bw.Flush()
[System.IO.File]::WriteAllBytes($Out, $ico.ToArray())
$bw.Dispose(); $ico.Dispose(); $big.Dispose(); $srcImg.Dispose()

# verify
$b2 = [System.IO.File]::ReadAllBytes($Out)
$c2 = [BitConverter]::ToUInt16($b2,4)
Write-Output ("DIB icon generated, frames: {0}" -f $c2)