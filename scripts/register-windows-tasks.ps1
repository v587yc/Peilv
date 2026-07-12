$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$currentUser = "$env:USERDOMAIN\$env:USERNAME"

$serverAction = New-ScheduledTaskAction `
    -Execute $nodePath `
    -Argument "dist/server.js" `
    -WorkingDirectory $projectRoot
$serverTrigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$serverSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal `
    -UserId $currentUser `
    -LogonType Interactive `
    -RunLevel Limited

Register-ScheduledTask `
    -TaskName "PeilvServer" `
    -Action $serverAction `
    -Trigger $serverTrigger `
    -Settings $serverSettings `
    -Principal $principal `
    -Force | Out-Null

$automationAction = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$projectRoot\scripts\dispatch-automation.ps1`""
$automationTrigger = New-ScheduledTaskTrigger `
    -Once `
    -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 1)
$automationSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 6)

Register-ScheduledTask `
    -TaskName "PeilvAutomation" `
    -Action $automationAction `
    -Trigger $automationTrigger `
    -Settings $automationSettings `
    -Principal $principal `
    -Force | Out-Null

$reconcileAction = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$projectRoot\scripts\reconcile-automation.ps1`""
$reconcileTrigger = New-ScheduledTaskTrigger `
    -Once `
    -At (Get-Date).AddMinutes(2) `
    -RepetitionInterval (New-TimeSpan -Minutes 15)
$reconcileSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 6)

Register-ScheduledTask `
    -TaskName "PeilvAutomationReconcile" `
    -Action $reconcileAction `
    -Trigger $reconcileTrigger `
    -Settings $reconcileSettings `
    -Principal $principal `
    -Force | Out-Null

Start-ScheduledTask -TaskName "PeilvServer"
Write-Output "scheduled-tasks-registered"
