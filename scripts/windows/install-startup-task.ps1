$ErrorActionPreference = "Stop"

param(
  [string]$TaskName = "GituAI Assistant",
  [switch]$RunAsAdmin
)

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$RunnerPath = Join-Path $RepoRoot "scripts\windows\run-gituai.ps1"

if (-not (Test-Path $RunnerPath)) {
  throw "Runner not found: $RunnerPath"
}

$Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$RunnerPath`""
$Trigger = New-ScheduledTaskTrigger -AtLogOn

$Principal = $null
if ($RunAsAdmin) {
  $Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType InteractiveToken -RunLevel Highest
} else {
  $Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType InteractiveToken
}

$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$Task = New-ScheduledTask -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings

try {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
} catch {}

Register-ScheduledTask -TaskName $TaskName -InputObject $Task | Out-Null

Write-Output "Installed scheduled task: $TaskName"
Write-Output "It will run at user logon. For Playwright visible mode, keep 'Run only when user is logged on'."

