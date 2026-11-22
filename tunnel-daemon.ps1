param(
  [int]$Port = 8123
)

$ErrorActionPreference = 'Continue'
$root = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$hostInfoPath = Join-Path $root 'host-info.json'

function Update-PublicUrl([string]$url) {
  try {
    $obj = if (Test-Path $hostInfoPath -PathType Leaf) {
      Get-Content -Path $hostInfoPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } else {
      [pscustomobject]@{ lanIp = ''; port = $Port; lanUrl = ''; publicUrl = '' }
    }
    $obj | Add-Member -MemberType NoteProperty -Name 'publicUrl' -Value $url -Force
    $obj | ConvertTo-Json | Set-Content -Path $hostInfoPath -Encoding UTF8
  } catch {}
}

function Start-SshTunnel([string]$targetHost, [string]$sshArgs) {
  Write-Output "[$(Get-Date -Format 'HH:mm:ss')] Starting HTTPS tunnel via $targetHost..."
  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = 'ssh.exe'
  $psi.Arguments = $sshArgs
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true

  $proc = [System.Diagnostics.Process]::new()
  $proc.StartInfo = $psi
  [void]$proc.Start()

  $outTask = $proc.StandardOutput.ReadLineAsync()
  $errTask = $proc.StandardError.ReadLineAsync()
  $foundUrl = $false
  $startedAt = Get-Date

  while (-not $proc.HasExited) {
    if ($outTask.IsCompleted) {
      $line = $outTask.Result
      if ($null -ne $line) {
        if ($line -match '(https://[a-zA-Z0-9-]+\.(?:app\.)?lhr\.life|https://[a-zA-Z0-9-]+\.serveousercontent\.com)') {
          $pub = $Matches[1]
          $foundUrl = $true
          Update-PublicUrl $pub
          Write-Output "TUNNEL_ACTIVE=$pub"
        } elseif ($line.Trim()) {
          Write-Output $line
        }
        $outTask = $proc.StandardOutput.ReadLineAsync()
      }
    }

    if ($errTask.IsCompleted) {
      $eline = $errTask.Result
      if ($null -ne $eline) {
        if ($eline -match '(https://[a-zA-Z0-9-]+\.(?:app\.)?lhr\.life|https://[a-zA-Z0-9-]+\.serveousercontent\.com)') {
          $pub = $Matches[1]
          $foundUrl = $true
          Update-PublicUrl $pub
          Write-Output "TUNNEL_ACTIVE=$pub"
        }
        $errTask = $proc.StandardError.ReadLineAsync()
      }
    }

    if (-not $foundUrl -and ((Get-Date) - $startedAt).TotalSeconds -gt 18) {
      Write-Output "Timeout waiting for URL from $targetHost, switching..."
      try { $proc.Kill() } catch {}
      break
    }

    Start-Sleep -Milliseconds 100
  }

  try { if (-not $proc.HasExited) { $proc.Kill() } } catch {}
  try { $proc.Dispose() } catch {}
  return $foundUrl
}

while ($true) {
  $lhrArgs = "-T -o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL -o ServerAliveInterval=25 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -R 80:127.0.0.1:$Port nokey@localhost.run"
  $ok = Start-SshTunnel -targetHost 'localhost.run' -sshArgs $lhrArgs

  if (-not $ok) {
    $serveoArgs = "-T -o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL -o ServerAliveInterval=25 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -R 80:127.0.0.1:$Port serveo.net"
    [void](Start-SshTunnel -targetHost 'serveo.net' -sshArgs $serveoArgs)
  }

  Update-PublicUrl ''
  Start-Sleep -Seconds 2
}
