# AppDelegate Refactor — Smoke Checklist

Repeatable manual checklist for verifying AppDelegate behavior after each extraction PR.
Run through this list after every PR in the refactor series to catch regressions early.

## App Launch

- [ ] Cold start: app launches without crash and menu bar icon appears
- [ ] Relaunch: quit and reopen — app recovers cleanly, no duplicate status items
- [ ] Daemon connection: status dot reflects connected/disconnected state within a few seconds

## Auth Flow

- [ ] Login: sign in via onboarding or menu completes successfully
- [ ] Logout: Sign Out from status menu clears session and returns to login state
- [ ] Switch assistant: changing assistant configuration reconnects without crash

## Bootstrap

- [ ] First-launch interstitial: onboarding flow appears on fresh install (or after clearing state)
- [ ] Retry on failure: if daemon is unreachable during bootstrap, retry mechanism works
- [ ] Stale-state recovery: killing the daemon mid-bootstrap and relaunching recovers gracefully

## Hotkeys

- [ ] Global hotkey (Cmd+Shift+G): toggles quick input popover from any app
- [ ] Quick input focus: popover text field is focused and ready for typing
- [ ] Cmd+K command palette: opens command palette within the main window
- [ ] Fn+V paste: paste shortcut works in active session
- [ ] Escape: dismisses popover / overlay / cancels active session as appropriate

## Quick Input

- [ ] Popover appears: clicking the menu bar icon shows the quick input popover
- [ ] Submit to new thread: typing a message and submitting creates a new conversation
- [ ] Submit to existing thread: submitting while a thread is active appends to it

## Voice

- [ ] PTT activation: holding the configured key (Fn/Ctrl) starts voice recording
- [ ] Partial transcription: live transcription text appears during recording
- [ ] Final transcription: releasing the key submits the recognized text
- [ ] Wake-word toggle: enabling/disabling wake word in settings takes effect

## Window Management

- [ ] Reopen behavior: clicking the menu bar icon after closing the window reopens it
- [ ] Settings window: Settings menu item opens the settings panel
- [ ] About panel: About menu item shows version information
- [ ] Dock badge: unseen conversation count appears on the dock icon (when applicable)

## Onboarding

- [ ] Replay via menu: "Replay Onboarding" from the status menu restarts the flow
- [ ] First-meeting flow: full onboarding sequence (naming, permissions, Fn key) completes

## Retire / Terminate

- [ ] Retire flow: signing out cleans up daemon and local state
- [ ] Clean termination: Quit from the status menu shuts down gracefully (no orphaned processes)
- [ ] Restart: Restart from the status menu relaunches the app cleanly
