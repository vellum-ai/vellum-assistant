---
name: windows-automation
description: Automate native Windows apps and system interactions with PowerShell, documented COM APIs, and Microsoft UI Automation through the Windows host executor. Use for launching or inspecting desktop apps, opening Windows Settings, controlling scriptable Microsoft Office apps, and interacting with native UI when no direct CLI or API is available.
compatibility: "Designed for Vellum personal assistants on Windows"
metadata:
  emoji: "🪟"
  vellum:
    category: "system"
    display-name: "Windows Automation"
    platforms:
      - windows
    activation-hints:
      - "Interacting with native Windows apps or system settings"
      - "Automating Microsoft Office desktop apps via PowerShell or COM"
      - "Inspecting or controlling a desktop app through Microsoft UI Automation"
    avoid-when:
      - "The task can be completed in the sandbox or through a direct CLI or API"
---

Use `host_bash` for every command in this skill. On Windows, `host_bash` runs Windows PowerShell with no profile and no interactive prompt. Use PowerShell syntax and Windows paths.

Prefer automation methods in this order:

1. A documented CLI or URI scheme
2. A documented PowerShell module or COM API
3. Microsoft UI Automation
4. Keyboard input only when the target and focus are verified

Avoid screen coordinates and blind keystrokes. They are fragile and can affect the wrong app. Use computer control only when PowerShell and UI Automation cannot complete the task or the user explicitly requests it.

## Discover and launch apps

```powershell
# Find Start menu apps
Get-StartApps | Where-Object Name -Like "*Calculator*"

# Inspect running desktop apps
Get-Process | Where-Object MainWindowTitle | Select-Object Id, ProcessName, MainWindowTitle

# Launch an app or a Windows Settings page
Start-Process calc.exe
Start-Process "ms-settings:privacy-microphone"

# Open a folder in File Explorer
Start-Process explorer.exe -ArgumentList "C:\Users\Public\Documents"
```

Prefer a stable executable, AppUserModelId, URI scheme, process ID, or automation ID over a localized window title.

## Use documented app automation

Microsoft Office desktop apps expose COM APIs. Check that the app is installed before relying on one. Keep the COM object alive for the full operation and release it when finished.

```powershell
# Open Excel without taking over an existing workbook
$excel = New-Object -ComObject Excel.Application
$excel.Visible = $true
$workbook = $excel.Workbooks.Add()
$worksheet = $workbook.Worksheets.Item(1)
$worksheet.Cells.Item(1, 1).Value2 = "Example"
```

Close temporary documents and call `[System.Runtime.InteropServices.Marshal]::ReleaseComObject(...)` for COM objects that are no longer needed.

## Gate consequential actions

Every PowerShell command sequence that saves, sends, deletes, or overwrites content must call `assistant ui confirm` and check its exit code before performing the action. Keep the confirmation and the action in the same `host_bash` invocation. Describe the exact action and target in the confirmation message.

```powershell
assistant ui confirm `
  --title "Save workbook" `
  --message "Save the new workbook to C:\Users\Public\Documents\example.xlsx?" `
  --confirm-label "Save" `
  --deny-label "Cancel"

if ($LASTEXITCODE -ne 0) {
  Write-Output "Save cancelled."
  exit 0
}

$workbook.SaveAs("C:\Users\Public\Documents\example.xlsx")
```

Use the same blocking pattern immediately before sending messages, deleting data, or overwriting existing content. A prose-only confirmation is not sufficient.

## Inspect native UI

Load the built-in UI Automation assemblies and identify elements by process ID, automation ID, control type, or name.

```powershell
Add-Type -AssemblyName UIAutomationClient

$desktop = [System.Windows.Automation.AutomationElement]::RootElement
$windows = $desktop.FindAll(
  [System.Windows.Automation.TreeScope]::Children,
  [System.Windows.Automation.Condition]::TrueCondition
)

$windows | ForEach-Object {
  [pscustomobject]@{
    Name = $_.Current.Name
    ProcessId = $_.Current.ProcessId
    AutomationId = $_.Current.AutomationId
    ControlType = $_.Current.ControlType.ProgrammaticName
  }
}
```

Once the target window is known, search its descendants with a `PropertyCondition` and use the supported pattern, such as `InvokePattern`, `ValuePattern`, `SelectionItemPattern`, or `TogglePattern`. Check `TryGetCurrentPattern` before invoking a pattern.

## Focus and keyboard fallback

If an app exposes no useful automation pattern, verify the process and window before sending keys:

```powershell
$process = Get-Process notepad -ErrorAction Stop | Select-Object -First 1
$shell = New-Object -ComObject WScript.Shell
if (-not $shell.AppActivate($process.Id)) {
  throw "Could not activate Notepad"
}
```

Use keyboard input only after activation succeeds. Re-check the foreground app before a destructive or irreversible action.

## Troubleshooting

- An empty UI Automation tree can mean the target runs at a higher integrity level. Do not bypass Windows security boundaries. Ask the user to run both apps at the same privilege level if appropriate.
- App names, window titles, and control names can be localized. Prefer process IDs and automation IDs.
- Packaged apps may launch through an AppUserModelId rather than a stable executable. Discover them with `Get-StartApps`.
- `host_bash` is non-interactive. Do not use commands that wait for terminal input or depend on a PowerShell profile.
