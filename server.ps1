# My Radio - tiny local server
# Serves this folder at http://localhost:8787/ and resolves MBC stream addresses (/mbc?ch=sfm|mfm|chm),
# which MBC does not allow browsers to fetch directly.
param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$port = 8787
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$types = @{ '.html'='text/html; charset=utf-8'; '.js'='text/javascript; charset=utf-8'; '.webmanifest'='application/manifest+json'; '.json'='application/json'; '.svg'='image/svg+xml'; '.png'='image/png'; '.jpg'='image/jpeg'; '.ico'='image/x-icon'; '.css'='text/css' }
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
try { $listener.Start() } catch {
  Write-Host "Port $port is busy - the radio may already be running. Opening browser..."
  if (-not $NoBrowser) { Start-Process "http://localhost:$port/" }; Start-Sleep 3; exit
}
Write-Host ""
Write-Host "  My Radio is running at http://localhost:$port/"
Write-Host "  Keep this window open while listening. Close it to stop."
Write-Host ""
if (-not $NoBrowser) { Start-Process "http://localhost:$port/" }
$wc = New-Object System.Net.WebClient
$wc.Encoding = [System.Text.Encoding]::UTF8
$rootFull = [System.IO.Path]::GetFullPath($root)
while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $req = $ctx.Request; $res = $ctx.Response
  try {
    $path = [Uri]::UnescapeDataString($req.Url.AbsolutePath)
    if ($path -eq '/mbc') {
      $ch = $req.QueryString['ch']
      if ($ch -notmatch '^(sfm|mfm|chm)$') { throw 'bad channel' }
      $wc.Headers['User-Agent'] = 'Mozilla/5.0'
      $txt = $wc.DownloadString("https://sminiplay.imbc.com/aacplay.ashx?agent=webapp&channel=$ch").Trim()
      $bytes = [System.Text.Encoding]::UTF8.GetBytes($txt)
      $res.ContentType = 'text/plain; charset=utf-8'
      $res.AddHeader('Cache-Control', 'no-store')
    } else {
      if ($path -eq '/') { $path = '/index.html' }
      $file = [System.IO.Path]::GetFullPath((Join-Path $root $path.TrimStart('/')))
      $ext = [System.IO.Path]::GetExtension($file).ToLower()
      if (-not $file.StartsWith($rootFull) -or -not (Test-Path $file -PathType Leaf) -or -not $types.ContainsKey($ext)) {
        $res.StatusCode = 404; $bytes = [System.Text.Encoding]::UTF8.GetBytes('not found')
      } else {
        $bytes = [System.IO.File]::ReadAllBytes($file)
        $res.ContentType = $types[$ext]
        $res.AddHeader('Cache-Control', 'no-cache')
      }
    }
  } catch {
    $res.StatusCode = 502; $bytes = [System.Text.Encoding]::UTF8.GetBytes('error')
  }
  try { $res.ContentLength64 = $bytes.Length; $res.OutputStream.Write($bytes, 0, $bytes.Length); $res.Close() } catch {}
}
