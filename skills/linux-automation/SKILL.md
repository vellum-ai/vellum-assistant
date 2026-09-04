---
name: linux-automation
description: Automate native Linux desktop apps and system interactions with xdg-open, desktop entries, D-Bus and xdg-desktop-portal calls, and X11 window tools through the Linux host executor. Use for launching or inspecting desktop apps, opening desktop settings pages, sending desktop notifications, reading and writing the clipboard, and controlling windows when no direct CLI or API is available.
compatibility: "Designed for Vellum personal assistants on Linux"
metadata:
  icon: assets/icon.svg
  emoji: "🐧"
  vellum:
    category: "system"
    display-name: "Linux Automation"
    platforms:
      - linux
    activation-hints:
      - "Interacting with native Linux desktop apps or desktop settings"
      - "Sending a desktop notification or using the clipboard on the host"
      - "Finding, focusing, or inspecting a window on an X11 session"
    avoid-when:
      - "The task can be completed in the sandbox or through a direct CLI or API"
---

Use `host_bash` for every command in this skill. On Linux, `host_bash` runs bash on the user's desktop session, so use POSIX paths and non-interactive commands.

Prefer automation methods in this order:

1. A documented CLI, URI scheme, or desktop entry
2. A documented D-Bus interface or `xdg-desktop-portal` call
3. X11 window tools, only on an X11 or XWayland session
4. Keyboard input only when the target and focus are verified

Avoid screen coordinates and blind keystrokes. They are fragile and can affect the wrong app. Use computer control only when the methods above cannot complete the task or the user explicitly requests it.

## Check the session first

Almost every branch below depends on the session type and desktop environment. Read them before choosing a tool.

```bash
echo "session=${XDG_SESSION_TYPE:-unknown} desktop=${XDG_CURRENT_DESKTOP:-unknown}"
```

- `x11`: window and input tools such as `wmctrl` and `xdotool` work.
- `wayland`: those tools see only XWayland clients and cannot enumerate or focus native Wayland windows. Use D-Bus, portals, and app CLIs instead, and tell the user when something is not possible rather than falling back to blind keystrokes.

Tools in this skill are not all installed by default. Check with `command -v <tool>` before using one. If it is missing, do not install it. Tell the user which package provides it for their distribution, for example `wmctrl`, `xdotool`, `xclip`, `wl-clipboard`, or `libnotify-bin` on Debian and Ubuntu.

## Discover and launch apps

Applications are described by desktop entries, and the entry's file name is its desktop ID.

```bash
# Find an installed app's desktop ID
grep -l -i "calculator" /usr/share/applications/*.desktop ~/.local/share/applications/*.desktop 2>/dev/null

# Launch by desktop ID, which applies the entry's own environment and scaling
gio launch org.gnome.Calculator.desktop
gtk-launch org.gnome.Calculator   # fallback when gio is unavailable

# Open a file, folder, or URL with the user's default handler
xdg-open ~/Documents
xdg-open https://example.com

# Inspect running desktop apps
ps -eo pid,comm,args --sort=-pcpu | head -30
```

Prefer a desktop ID, a stable executable, or a URI scheme over a localized window title. `xdg-settings get default-web-browser` and `xdg-mime query default <mimetype>` report which app will handle an open.

## Open desktop settings

Settings panes are desktop-specific and have no shared URI scheme. Match the command to `XDG_CURRENT_DESKTOP`.

```bash
gnome-control-center sound          # GNOME
systemsettings kcm_pulseaudio       # KDE Plasma
xfce4-settings-manager              # Xfce
```

If the matching command is missing, describe the path through the desktop's settings app instead of guessing another command.

## Use D-Bus and portals

Most desktop services expose D-Bus interfaces. Introspect before calling so the method signature is known rather than assumed.

```bash
# List session services and inspect one
busctl --user list
gdbus introspect --session --dest org.freedesktop.portal.Desktop \
  --object-path /org/freedesktop/portal/desktop --only-properties

# Call a documented method
gdbus call --session --dest org.freedesktop.FileManager1 \
  --object-path /org/freedesktop/FileManager1 \
  --method org.freedesktop.FileManager1.ShowItems "['file:///home/user/notes.txt']" ""
```

Portal methods under `org.freedesktop.portal.*` are asynchronous: the call returns a request object path, and the result arrives as a `Response` signal. A portal request can also open a user consent dialog, so treat a call that appears to hang as one waiting on the user rather than retrying it.

## Send a notification

```bash
notify-send "Backup finished" "42 files copied"
notify-send -u critical -i dialog-warning "Disk almost full" "3% free on /"
```

`notify-send` is the documented wrapper over `org.freedesktop.Notifications`. Use `gdbus call` against that interface directly only when an action or a replacement ID is needed.

## Read and write the clipboard

The clipboard tool depends on the session type.

```bash
# X11
printf '%s' "text to copy" | xclip -selection clipboard
xclip -selection clipboard -o

# Wayland
printf '%s' "text to copy" | wl-copy
wl-paste --no-newline
```

The clipboard belongs to the user. Read it only when the user asked for its contents, and say what was written before replacing it.

## Inspect and control windows on X11

These commands work on an X11 session and on XWayland clients only. Skip them when `XDG_SESSION_TYPE` is `wayland`.

```bash
# List windows with their IDs, desktop, and title
wmctrl -l -p

# Find a window by class rather than a localized title
xdotool search --classname "gnome-terminal"

# Activate a specific window ID
xdotool windowactivate 0x03400007

# Read the currently focused window
xdotool getactivewindow getwindowname
```

Prefer a window class or process ID over a title. Titles are localized and change as the user works.

## Consequential actions are unsupported

Do not use this skill to save, send, delete, or overwrite content. The Linux host executor does not provide an in-process confirmation gate that works for both local and remote assistants.

Treat every existing document, message, note, calendar item, file, and cloud-backed resource as read-only. Autosave can persist an edit without an explicit save command. Only edit an isolated temporary document that the automation created during the current task, has no storage path or cloud connection, and has autosave definitively disabled. If those conditions cannot be verified, do not edit it.

If the user requests a consequential action, use a dedicated skill or product workflow with its own hard confirmation gate. If none is available, explain the limitation and ask the user to perform that final action manually.

## Focus and keyboard fallback

If an app exposes no useful CLI or D-Bus interface, verify focus before sending keys, and only on X11:

```bash
target=$(xdotool search --classname "gedit" | head -1)
xdotool windowactivate --sync "$target" || { echo "Could not activate the window"; exit 1; }
xdotool key --window "$target" ctrl+f
```

Use keyboard input only after activation succeeds. Never use keyboard input to trigger a consequential action prohibited above.

## Troubleshooting

- An empty window list on a Wayland session is expected, not a failure. Native Wayland clients are invisible to X11 tools by design. Do not work around it with blind keystrokes.
- `gio launch` fails on a desktop entry that needs a terminal or a field code. Run the entry's `Exec` line directly in that case, after reading it.
- App names, window titles, and settings labels are localized. Prefer desktop IDs, window classes, and process IDs.
- A D-Bus call that reports an unknown method usually means the service version differs. Introspect the live object instead of trusting documentation for another release.
- `host_bash` is non-interactive. Do not use commands that wait for terminal input, and never run `sudo`, which cannot prompt for a password.
