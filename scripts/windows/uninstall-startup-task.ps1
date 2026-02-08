$ErrorActionPreference = "Stop"

param(
  [string]$TaskName = "GituAI Assistant"
)

try {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false | Out-Null
  Write-Output "Removed scheduled task: $TaskName"
} catch {
  Write-Output "Scheduled task not found: $TaskName"
}

