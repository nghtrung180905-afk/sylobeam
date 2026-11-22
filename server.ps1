param(
  [int]$Port = 8123
)

$ErrorActionPreference = 'Stop'
$root = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$root = [System.IO.Path]::GetFullPath($root)

function Get-PrimaryLanIp {
  $ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
      $_.InterfaceAlias -notmatch 'Loopback|vEthernet|WSL|Docker|CloudflareWARP|Tailscale|ZeroTier' -and
      $_.IPAddress -notmatch '^169\.254\.' -and
      $_.IPAddress -ne '127.0.0.1'
    } | Sort-Object -Property InterfaceMetric
  if ($ips) { return @($ips)[0].IPAddress }

  $fallback = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.InterfaceAlias -notmatch 'Loopback' -and $_.IPAddress -notmatch '^169\.254\.' }
  if ($fallback) { return @($fallback)[0].IPAddress }

  return '127.0.0.1'
}

$lanIp = Get-PrimaryLanIp
$hostInfoFile = Join-Path $root 'host-info.json'

# Initialize host-info.json preserving any existing publicUrl if non-empty
$initialPublicUrl = ''
if (Test-Path $hostInfoFile -PathType Leaf) {
  try {
    $existing = Get-Content -Path $hostInfoFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($existing -and $existing.publicUrl) {
      $initialPublicUrl = [string]$existing.publicUrl
    }
  } catch {}
}

$initialObj = [ordered]@{
  lanIp     = $lanIp
  port      = $Port
  lanUrl    = "http://${lanIp}:${Port}"
  publicUrl = $initialPublicUrl
}
$initialObj | ConvertTo-Json | Set-Content -Path $hostInfoFile -Encoding UTF8

$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'application/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.jpeg' = 'image/jpeg'
  '.ico'  = 'image/x-icon'
  '.md'   = 'text/markdown; charset=utf-8'
}

$handlerScript = {
  param($client, $rootPath, $serverPort, $detectedLanIp, $hostInfoPath, $mimeMap)
  try {
    $client.ReceiveTimeout = 5000
    $client.SendTimeout = 5000
    $stream = $client.GetStream()
    $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::ASCII, $false, 1024, $true)

    $requestLine = $reader.ReadLine()
    if ([string]::IsNullOrWhiteSpace($requestLine)) {
      return
    }

    while ($true) {
      $line = $reader.ReadLine()
      if ($null -eq $line -or $line -eq '') { break }
    }

    $parts = $requestLine -split ' '
    if ($parts.Length -lt 2) { return }
    $method = $parts[0].ToUpperInvariant()
    $rawTarget = $parts[1]
    $pathOnly = ($rawTarget -split '\?')[0]
    try {
      $pathOnly = [System.Uri]::UnescapeDataString($pathOnly)
    } catch {}

    if ($pathOnly -eq '/' -or [string]::IsNullOrEmpty($pathOnly)) {
      $pathOnly = '/index.html'
    }

    $statusLine = 'HTTP/1.1 200 OK'
    $contentType = 'application/octet-stream'
    $cacheControl = 'no-cache'
    [byte[]]$bodyBytes = @()

    if ($pathOnly -eq '/api/host-info' -or $pathOnly -eq '/host-info.json') {
      $pubUrl = ''
      if (Test-Path $hostInfoPath -PathType Leaf) {
        try {
          $parsed = Get-Content -Path $hostInfoPath -Raw -Encoding UTF8 | ConvertFrom-Json
          if ($parsed -and $parsed.publicUrl) {
            $pubUrl = [string]$parsed.publicUrl
          }
        } catch {}
      }
      $payload = [ordered]@{
        lanIp     = $detectedLanIp
        port      = $serverPort
        lanUrl    = "http://${detectedLanIp}:${serverPort}"
        publicUrl = $pubUrl
      } | ConvertTo-Json -Compress
      $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
      $contentType = 'application/json; charset=utf-8'
      $cacheControl = 'no-store, no-cache, must-revalidate'
    } else {
      $relPath = $pathOnly.TrimStart('/') -replace '/', '\'
      $fullPath = [System.IO.Path]::GetFullPath((Join-Path $rootPath $relPath))
      $safeRoot = if ($rootPath.EndsWith('\')) { $rootPath } else { "$rootPath\" }

      if ($fullPath.StartsWith($safeRoot, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path $fullPath -PathType Leaf)) {
        $ext = [System.IO.Path]::GetExtension($fullPath).ToLowerInvariant()
        if ($mimeMap.ContainsKey($ext)) {
          $contentType = $mimeMap[$ext]
        }
        $bodyBytes = [System.IO.File]::ReadAllBytes($fullPath)
      } else {
        $statusLine = 'HTTP/1.1 404 Not Found'
        $contentType = 'text/plain; charset=utf-8'
        $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes('404 Not Found')
      }
    }

    $headerText = "$statusLine`r`n" +
      "Content-Type: $contentType`r`n" +
      "Content-Length: $($bodyBytes.Length)`r`n" +
      "Cache-Control: $cacheControl`r`n" +
      "Access-Control-Allow-Origin: *`r`n" +
      "Connection: close`r`n`r`n"
    $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($headerText)
    $stream.Write($headerBytes, 0, $headerBytes.Length)
    if ($method -ne 'HEAD' -and $bodyBytes.Length -gt 0) {
      $stream.Write($bodyBytes, 0, $bodyBytes.Length)
    }
    $stream.Flush()
  } catch {
    # Ignore transient client disconnects
  } finally {
    try { $client.Close() } catch {}
  }
}

$pool = [runspacefactory]::CreateRunspacePool(1, 16)
$pool.Open()
$activeTasks = [System.Collections.ArrayList]::new()

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $Port)
$listener.Start()

Write-Output "Listening on http://0.0.0.0:$Port (localhost: http://localhost:$Port | LAN: http://${lanIp}:$Port)"

try {
  while ($true) {
    # Clean up completed runspaces
    for ($i = $activeTasks.Count - 1; $i -ge 0; $i--) {
      $item = $activeTasks[$i]
      if ($item.Handle.IsCompleted) {
        try { $item.PS.EndInvoke($item.Handle) } catch {}
        $item.PS.Dispose()
        $activeTasks.RemoveAt($i)
      }
    }

    if ($listener.Pending()) {
      $client = $listener.AcceptTcpClient()
      $ps = [powershell]::Create()
      $ps.RunspacePool = $pool
      [void]$ps.AddScript($handlerScript).AddArgument($client).AddArgument($root).AddArgument($Port).AddArgument($lanIp).AddArgument($hostInfoFile).AddArgument($mime)
      $handle = $ps.BeginInvoke()
      [void]$activeTasks.Add([pscustomobject]@{ PS = $ps; Handle = $handle })
    } else {
      Start-Sleep -Milliseconds 10
    }
  }
} finally {
  $listener.Stop()
  $pool.Close()
  $pool.Dispose()
}
