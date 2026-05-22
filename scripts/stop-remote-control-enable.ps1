param(
  [int]$Port = 17897
)

$ErrorActionPreference = 'Stop'

$processIds = New-Object System.Collections.Generic.HashSet[int]

try {
  Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
    ForEach-Object {
      if ($_.OwningProcess -and $_.OwningProcess -gt 0) {
        [void]$processIds.Add([int]$_.OwningProcess)
      }
    }
} catch {
  Write-Warning "Could not inspect TCP port $Port: $($_.Exception.Message)"
}

Get-CimInstance Win32_Process |
  Where-Object {
    $_.CommandLine -match 'try-remote-control-enable\.mjs' -or
    $_.CommandLine -match "--listen ws://127\.0\.0\.1:$Port"
  } |
  ForEach-Object {
    if ($_.ProcessId -and $_.ProcessId -gt 0) {
      [void]$processIds.Add([int]$_.ProcessId)
    }
  }

if ($processIds.Count -eq 0) {
  Write-Host "No temporary remote-control enable processes found for port $Port."
  exit 0
}

Write-Host "Stopping temporary remote-control enable processes: $($processIds -join ', ')"
foreach ($processId in $processIds) {
  try {
    Stop-Process -Id $processId -Force -ErrorAction Stop
  } catch {
    Write-Warning "Could not stop PID $processId: $($_.Exception.Message)"
  }
}

