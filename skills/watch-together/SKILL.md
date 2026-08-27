---
name: "watch-together"
description: "Watch local TV shows and movies with the user in real time. An editor model watches each playback window, transcribes dialogue, and picks story-critical frames. Source mode plays local media in mpv; screen mode captures supported desktops as a fallback."
metadata:
  emoji: "📺"
  vellum:
    category: "content"
    display-name: "Watch Together"
    emoji: 📺
    platforms:
      - macos
      - windows
      - linux
---

# Watch Together

Real-time co-watching. An editor model watches playback continuously and wakes
the assistant only at moments worth reacting to. Each wake includes dialogue
and story-critical frames. Wakes arrive through signal files, so do not poll.

## Choose a mode

### Source mode (preferred)

`watch-file.py` plays a local media file in mpv and reads that file directly.
It does not capture the screen or require a loopback audio driver. Frames come
from the source at full quality. Sidecar `.srt` subtitles or the first embedded
text subtitle track provide exact dialogue. Without subtitles, the editor
transcribes audio. Pause stops the flow and seeks resynchronize it.

Use source mode whenever the user has a local media file. The bundled script
does not accept stream URLs.

### Screen mode (fallback)

`capture_live.py` records supported desktops through ffmpeg and feeds completed
segments to the same editor pipeline.

- **macOS:** Uses AVFoundation. It auto-detects BlackHole for audio and records
  video only when BlackHole is unavailable.
- **Windows:** Uses ffmpeg `gdigrab`. It records video only by default. System
  audio requires an existing DirectShow playback source such as Stereo Mix or
  a configured virtual audio cable, passed explicitly as the audio device.
- **Linux:** Uses X11 capture and `$DISPLAY`. It records video only by default.
  System audio requires an existing PulseAudio or PipeWire-Pulse monitor source
  passed explicitly. Native Wayland screen capture is not supported by this
  script.

Screen capture cannot bypass DRM or protected-video blanking. If browser video
is black in the recording, explain that screen mode is unsupported for that
content. Do not claim the fallback works around content protection.

## How it works

1. Playback is divided into 60-second windows.
2. `editor.py` reviews each window, selects story-critical frames, collects
   dialogue, and decides whether to wake now or hold a developing moment.
3. A wake extracts the selected frames at 720p and sends a `[WATCH]` message to
   the active conversation.
4. The assistant looks at the frames and dialogue and reacts only when useful.

The editor chooses when the assistant looks and what evidence it receives. The
assistant decides whether to speak and how to react. A hard cap controlled by
`WATCH_MAX_HOLD` prevents indefinite holds.

## When a `[WATCH]` message arrives

1. Inspect the attached frames with vision.
2. Read the dialogue as the primary source for the window.
3. React naturally. A short line, a stage direction, or silence can all be
   appropriate. Reserve longer reactions for moments that earn them.
4. Track theories, callbacks, and running jokes in replies so memory can carry
   them between sessions.

If a moment needs closer inspection, extract dense 720p frames from the source
named in the wake.

**macOS or Linux:**

```bash
python3 "$VELLUM_WORKSPACE_DIR/watch-together/scripts/rewind.py" \
  <source-file> <output-dir> <start-seconds> <end-seconds>
```

The existing `rewind.sh` command remains a POSIX compatibility wrapper.

**Windows PowerShell:**

```powershell
py -3 "$env:VELLUM_WORKSPACE_DIR\watch-together\scripts\rewind.py" `
  <source-file> <output-dir> <start-seconds> <end-seconds>
```

If the Python launcher is unavailable but `python --version` reports Python 3,
replace `py -3` with `python`.

## Start a session

Choose a stable lowercase session ID such as `example-show-s1e1`. Do not include
personal data in it.

### macOS or Linux

Create the session directory:

```bash
SESSION_ID="example-show-s1e1"
mkdir -p "$VELLUM_WORKSPACE_DIR/watch-together/sessions/$SESSION_ID"
```

Source mode:

```bash
python3 "$VELLUM_WORKSPACE_DIR/watch-together/scripts/watch-file.py" \
  <local-media-file> \
  "$VELLUM_WORKSPACE_DIR/watch-together/sessions/$SESSION_ID" \
  <conversation-id>
```

Screen mode:

```bash
python3 "$VELLUM_WORKSPACE_DIR/watch-together/scripts/capture_live.py" \
  "$VELLUM_WORKSPACE_DIR/watch-together/sessions/$SESSION_ID" \
  <conversation-id>
```

On macOS, the optional positional arguments are chunk seconds, AVFoundation
screen index, and AVFoundation audio index. The default screen index remains
`2`, and BlackHole is auto-detected when no audio index is supplied.

On Linux, `$DISPLAY` is used by default. To add system audio, pass chunk seconds,
the X11 display, and a Pulse monitor source:

```bash
python3 "$VELLUM_WORKSPACE_DIR/watch-together/scripts/capture_live.py" \
  "$VELLUM_WORKSPACE_DIR/watch-together/sessions/$SESSION_ID" \
  <conversation-id> 60 "$DISPLAY" <pulse-monitor-source>
```

### Windows PowerShell

Create the session directory:

```powershell
$SessionId = "example-show-s1e1"
$SessionDir = Join-Path $env:VELLUM_WORKSPACE_DIR "watch-together\sessions\$SessionId"
New-Item -ItemType Directory -Force $SessionDir | Out-Null
```

Source mode:

```powershell
py -3 "$env:VELLUM_WORKSPACE_DIR\watch-together\scripts\watch-file.py" `
  <local-media-file> $SessionDir <conversation-id>
```

Screen mode, video only:

```powershell
py -3 "$env:VELLUM_WORKSPACE_DIR\watch-together\scripts\capture_live.py" `
  $SessionDir <conversation-id>
```

Screen mode with a configured DirectShow playback source:

```powershell
ffmpeg -list_devices true -f dshow -i dummy
py -3 "$env:VELLUM_WORKSPACE_DIR\watch-together\scripts\capture_live.py" `
  $SessionDir <conversation-id> 60 desktop "<DirectShow-audio-device>"
```

Do not describe the optional Windows audio path as automatic loopback. The user
must already have a playback capture source exposed through DirectShow.

After giving the matching command, tell the user to start the show. When mpv
exits or screen capture stops, the final window is flushed.

The conversation ID is the bare UUID from the conversation database record,
not the timestamped conversation folder name. Using the folder name routes the
wake incorrectly.

## Cost setup

Watching produces many small turns. Recommend normal inference mode and an
inference profile with a reduced context ceiling so the conversation compacts
regularly. Example:

```jsonc
"llm": {
  "profiles": {
    "watch-mode": {
      "contextWindow": { "maxInputTokens": 200000 }
    }
  }
}
```

## Environment variables

- `GEMINI_API_KEY`: Enables editor verdicts and transcription. Without it,
  fixed-cadence wakes use evenly spaced frames and no editor transcription.
- `GEMINI_MODEL`: Editor model. Defaults to `gemini-3-flash-preview`.
- `WATCH_MAX_HOLD`: Maximum seconds between wakes. Defaults to `240`.
- `WATCH_MAX_FRAMES`: Maximum frames attached per wake. Defaults to `8`.
- `WATCH_MPV_ARGS`: Extra mpv arguments for source mode. Quoted arguments use
  the current platform's command-line rules.

## Prerequisites

All modes require Python 3 and ffmpeg. Source mode also requires mpv. Confirm
each command is on `PATH` before starting.

**macOS:**

```bash
brew install ffmpeg mpv
brew install blackhole-2ch  # optional screen-mode system audio
```

Configure a Multi-Output Device in Audio MIDI Setup when using BlackHole.

**Windows:** Install current Python 3, ffmpeg, and mpv builds, add them to
`PATH`, then verify:

```powershell
py -3 --version
ffmpeg -version
ffprobe -version
mpv --version
```

**Linux:** Install the distro packages. For Debian or Ubuntu:

```bash
sudo apt install python3 ffmpeg mpv
```

For Fedora:

```bash
sudo dnf install python3 ffmpeg mpv
```

## File locations

- Scripts: `$VELLUM_WORKSPACE_DIR/watch-together/scripts/`
- Sessions: `$VELLUM_WORKSPACE_DIR/watch-together/sessions/<session-id>/`
  - `chunks/`: Recorded segments from screen mode
  - `editor/verdicts/`: Per-window editor output
  - `wakes/wake-NNN/`: Frames attached to each wake
  - `editor-state.json`: Held-window state
  - `subs.srt`: Extracted source-mode subtitles
  - `mpv.sock`: POSIX source-mode IPC socket; Windows uses a named pipe
- Signals: JSON files at
  `$VELLUM_WORKSPACE_DIR/signals/user-message.<requestId>` with optional image
  attachments
