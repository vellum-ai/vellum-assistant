---
name: macos-automation
description: Automate native macOS apps and system interactions via osascript (AppleScript)
compatibility: "Designed for Vellum personal assistants"
metadata: {"emoji":"🍎","vellum":{"display-name":"macOS Automation","user-invocable":false,"os":["darwin"]}}
---

Use this skill to interact with native macOS apps and system-level features via `osascript` (AppleScript) through `host_bash`. Always prefer osascript over browser automation or computer-use for anything involving a native macOS app.

## Supported Apps

**Communication:** Messages, Mail, Microsoft Outlook, FaceTime
**Contacts & Calendar:** Contacts, Calendar, Reminders
**Notes & Writing:** Notes, TextEdit, Pages, BBEdit, CotEditor
**Files:** Finder, Path Finder
**Browsers:** Safari, Google Chrome
**Music & Media:** Music (iTunes), Spotify, VLC, Podcasts, TV
**Productivity:** OmniFocus, Things 3, OmniOutliner, OmniPlan, OmniGraffle
**Office:** Microsoft Word, Microsoft Excel, Numbers, Keynote
**Developer tools:** Xcode, Terminal, iTerm2, Script Editor
**System:** System Events (UI scripting for any app), System Settings
**Automation:** Keyboard Maestro, Alfred, Automator
**Creative:** Adobe Photoshop, Final Cut Pro

For any unlisted app, check scriptability first:
```bash
osascript -e 'tell application "AppName" to get name'
```

## Examples

```bash
# Send an iMessage
osascript -e 'tell application "Messages" to send "Hello!" to buddy "user@example.com"'

# Look up a contact
osascript -e 'tell application "Contacts" to get {name, phones} of every person whose name contains "Marina"'

# Read upcoming calendar events
osascript -e 'tell application "Calendar" to get summary of every event of calendar "Home" whose start date > (current date)'

# Create a reminder
osascript -e 'tell application "Reminders" to make new reminder with properties {name:"Buy milk", due date:((current date) + 1 * hours)}'

# Send an email
osascript -e 'tell application "Mail" to send (make new outgoing message with properties {subject:"Hi", content:"Hello", visible:true})'

# Create a note
osascript -e 'tell application "Notes" to make new note at folder "Notes" with properties {body:"My note"}'

# Open a URL in Safari
osascript -e 'tell application "Safari" to open location "https://example.com"'

# Play/pause Music
osascript -e 'tell application "Music" to playpause'

# Display a system notification
osascript -e 'display notification "Done!" with title "Vellum"'
```

## Tips

- For multi-line scripts, write them to a `.applescript` file and run with `osascript path/to/script.applescript`
- Use `System Events` for UI scripting apps that don't have their own AppleScript dictionary
- AppleScript permissions are gated by macOS TCC — if a command fails with a permission error, use `request_system_permission` to prompt the user
