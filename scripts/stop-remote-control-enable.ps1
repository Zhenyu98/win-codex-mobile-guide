param(
  [int]$Port = 0
)

$ErrorActionPreference = 'Stop'

$processIds = New-Object System.Collections.Generic.HashSet[int]

if ($Port -gt 0) {
  try {
    Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
      ForEach-Object {
        if ($_.OwningProcess -and $_.OwningProcess -gt 0) {
          [void]$processIds.Add([int]$_.OwningProcess)
        }
      }
  } catch {
    Write-Warning "Could not inspect TCP port ${Port}: $($_.Exception.Message)"
  }
}

Get-CimInstance Win32_Process |
  Where-Object {
    $_.CommandLine -match 'try-remote-control-enable\.mjs' -or
    (
      $Port -gt 0 -and
      $_.CommandLine -match "--listen ws://127\.0\.0\.1:$Port"
    ) -or
    (
      $Port -eq 0 -and
      $_.CommandLine -match '--listen ws://127\.0\.0\.1:\d+'
    )
  } |
  ForEach-Object {
    if ($_.ProcessId -and $_.ProcessId -gt 0) {
      [void]$processIds.Add([int]$_.ProcessId)
    }
  }

if ($processIds.Count -eq 0) {
  if ($Port -gt 0) {
    Write-Host "No temporary remote-control enable processes found for port $Port."
  } else {
    Write-Host "No temporary remote-control enable processes found."
  }
  exit 0
}

Write-Host "Stopping temporary remote-control enable processes: $($processIds -join ', ')"
foreach ($processId in $processIds) {
  try {
    Stop-Process -Id $processId -Force -ErrorAction Stop
  } catch {
    Write-Warning "Could not stop PID ${processId}: $($_.Exception.Message)"
  }
}
