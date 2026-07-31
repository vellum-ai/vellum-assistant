# Raspberry Pi live voice

`vellum voice` is a foreground PipeWire client for the assistant's existing
live-voice session. The assistant still owns speech recognition, speech
synthesis, the front-door model, the main agent loop, conversation persistence,
and model/provider selection.

## Validation status

The initial transport spike ran on this exact configuration:

| Component       | Tested value                                             |
| --------------- | -------------------------------------------------------- |
| Board           | Raspberry Pi 5 Model B Rev 1.1                           |
| RAM             | 15 GiB                                                   |
| OS              | Debian GNU/Linux 13 (Trixie)                             |
| Architecture    | aarch64                                                  |
| Bun             | 1.3.14                                                   |
| PipeWire tools  | 1.4.2                                                    |
| Assistant route | Direct local gateway                                     |
| Provider mode   | `IS_PLATFORM=1` with platform-managed and BYOK providers |

The spike proved the real `bun install -g vellum@latest` package path, assistant
preflight, binary microphone upload, streamed PCM playback, the front-door call
site, and main-agent handoff. It did not run PipeWire as the active audio server
and did not test a Vellum-managed route through Velay. The final hardware gate
at the end of this guide is pending. Do not treat this document as a support
announcement until that table is completed and approved.

The ten-turn server-VAD run completed 7 of 10 turns. All failures were the same
late-STT discard race, not resource exhaustion. The implementation adds a
bounded late-final grace, but the final open-mic gate must prove that fix on
hardware. Successful turns met the initial ready and first-audio latency
thresholds. The stack used about 469 MB RSS, had no swap growth, and showed no
OOM, restart, or thermal throttling.

No smaller board, RAM size, or older OS is claimed. Docker assistants,
assistants paired from another machine, and non-interactive service operation
are unsupported for this release.

## Install

Install Bun and then the published wrapper:

```bash
bun install -g vellum
vellum --version
vellum voice --help
```

The `vellum` package contains a Bun wrapper. That wrapper imports the published
TypeScript `@vellumai/cli` package, which includes its workspace dependencies.
`compile:check` is CI validation and is not the artifact installed on the Pi.

## Install and start PipeWire

Voice requires PipeWire 1.4 or newer, `pw-record`, `pw-play`, `pw-dump`, and
WirePlumber. On a Debian 13 Lite-style image:

```bash
sudo apt update
sudo apt install pipewire pipewire-audio pipewire-pulse pipewire-bin wireplumber
systemctl --user enable --now pipewire.socket wireplumber.service
systemctl --user enable --now pipewire-pulse.socket
sudo loginctl enable-linger "$USER"
```

The initial Pi used PulseAudio 17.0 as its active server even though PipeWire
tools were installed. Migrate the user session before running voice:

```bash
systemctl --user disable --now pulseaudio.service pulseaudio.socket
systemctl --user enable --now pipewire.socket pipewire-pulse.socket
systemctl --user enable --now wireplumber.service
systemctl --user restart pipewire pipewire-pulse wireplumber
```

Log out and back in if the user bus still has stale PulseAudio state. Verify the
session:

```bash
systemctl --user --no-pager status pipewire wireplumber pipewire-pulse
loginctl show-user "$USER" -p Linger
pw-dump >/dev/null
```

Bluetooth audio was not validated in the spike. Use wired, USB, or directly
attached ALSA hardware for the final validation baseline. Headless Bluetooth pairing,
profile selection, and reconnect behavior remain outside the current claim.

## Headless and SSH sessions

PipeWire and WirePlumber run in the login user's systemd user session. Linger
keeps that user session available after an SSH boundary, but `vellum voice`
itself remains a foreground interactive command.

Use the same Unix user that owns the audio devices. Confirm this runtime path
exists:

```bash
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
test -S "$XDG_RUNTIME_DIR/pipewire-0"
```

Start `tmux` after the user audio session is active so it inherits the correct
`XDG_RUNTIME_DIR` and user bus. A voice command inside `tmux` can survive an SSH
disconnect. Outside `tmux`, SSH loss sends `SIGHUP`; the CLI stops capture,
flushes playback, closes the socket, and exits.

Non-interactive system services are unsupported. Do not run `vellum voice` as
root or from a system unit.

## Choose and diagnose devices

List stable PipeWire node names and object serials:

```bash
vellum voice devices
vellum voice devices --json
```

Run diagnostics before opening the microphone:

```bash
vellum voice doctor assistant-123
vellum voice doctor assistant-123 --json
```

Choose explicit devices for push-to-talk:

```bash
vellum voice assistant-123 \
  --input-device alsa_input.example_mic \
  --output-device alsa_output.example_speakers
```

Node names are safer across process restarts than transient PipeWire object
IDs. Rerun `voice devices` after unplugging USB hardware or changing an audio
profile.

## Direct local assistants

A normal locally hatched assistant uses its directly reachable gateway:

```bash
vellum voice doctor assistant-123
vellum voice assistant-123
```

For a manually provisioned assistant, provide the gateway and exact assistant
ID:

```bash
vellum voice doctor \
  --url http://127.0.0.1:7830 \
  --assistant-id assistant-123

vellum voice \
  --url http://127.0.0.1:7830 \
  --assistant-id assistant-123
```

`--url` always means direct gateway routing. This remains true when the local
assistant has `IS_PLATFORM=1` and uses platform-managed STT, TTS, or LLM
providers. Provider ownership does not change the network route.

Remote direct gateways require TLS and guardian authentication. A guardian
token is sent as a WebSocket header and never placed in the URL.

## Vellum-managed assistants

Authenticate with a user session, select the managed assistant, and run voice:

```bash
vellum login
vellum ps
vellum voice doctor assistant-123
vellum voice assistant-123
```

The CLI uses the stored platform session to mint a short-lived,
assistant-scoped live-voice token, then connects through the
environment-matched Velay host. The platform session token is never put in the
WebSocket URL. Vellum API keys cannot mint this user-session credential.

## Push-to-talk

Push-to-talk is the default and does not require acoustic echo cancellation:

```bash
vellum voice assistant-123
```

Press Enter to begin capture and Enter again to release the utterance. Keep the
terminal focused. Use `s` to interrupt playback, `c` to cycle captions, and `q`
to exit.

## Configure echo-cancelled open mic

Open mic is optional. It is allowed only when one
`libpipewire-module-echo-cancel` instance owns both exact virtual nodes:

- Capture source: `vellum_echo_cancel_source`
- Playback sink: `vellum_echo_cancel_sink`

Find the real microphone and speaker `node.name` values with `pw-dump` or
`wpctl status`. Replace the two example targets below, then create
`~/.config/pipewire/pipewire.conf.d/90-vellum-echo-cancel.conf`. The stream
layout follows PipeWire's
[echo-cancel module](https://docs.pipewire.org/page_module_echo_cancel.html):

```ini
context.modules = [
  {
    name = libpipewire-module-echo-cancel
    args = {
      library.name = aec/libspa-aec-webrtc
      monitor.mode = false
      audio.rate = 48000
      audio.channels = 1
      audio.position = [ MONO ]

      capture.props = {
        node.name = "vellum_echo_cancel_capture"
        target.object = "alsa_input.example_real_microphone"
      }
      source.props = {
        node.name = "vellum_echo_cancel_source"
        node.description = "Vellum Echo-Cancelled Microphone"
        media.class = "Audio/Source"
      }
      sink.props = {
        node.name = "vellum_echo_cancel_sink"
        node.description = "Vellum Echo-Cancel Playback"
        media.class = "Audio/Sink"
      }
      playback.props = {
        node.name = "vellum_echo_cancel_playback"
        target.object = "alsa_output.example_real_speakers"
      }
    }
  }
]
```

Restart the graph and verify the pair:

```bash
systemctl --user restart pipewire pipewire-pulse wireplumber
vellum voice doctor assistant-123 --mode open-mic
vellum voice assistant-123 --mode open-mic
```

Open mic always captures from the virtual source and sends TTS to the paired
virtual sink. That sink supplies the far-end playback reference to the echo
canceller. The CLI does not accept an unsafe device override for open mic.
Press `m` to mute, `s` to interrupt, `c` to cycle captions, and `q` to exit.

## Privacy and diagnostics

The CLI streams microphone PCM to the selected assistant and plays returned
PCM. Audio probes stay in memory. The CLI does not write microphone or TTS PCM
to disk. Echo diagnostics retain only scalar amplitude, floor, margin, peak,
and correlation summaries. Transcript captions are off by default.

Assistant-side conversation and audio persistence follows the assistant's
live-voice storage policy. Use `VELLUM_DEBUG=1` only when collecting support
evidence. Debug output redacts long-lived credentials and does not contain PCM
or transcript text.

## Failure recovery

- If `voice doctor` reports no user session, check linger, the user bus, and
  `XDG_RUNTIME_DIR` before checking hardware.
- If a node disappears, reconnect the device, rerun `voice devices`, and rerun
  doctor. Open mic must rediscover the complete echo-cancel pair.
- A busy response means another live-voice client owns the assistant's single
  session. End that session and retry. The CLI never steals it.
- Service-restart and overload closes use bounded reconnects. A managed
  reconnect mints a new short-lived token.
- After network loss, rerun doctor before resuming if the audio graph also
  restarted.
- `Ctrl+C`, `SIGTERM`, and `SIGHUP` stop capture, flush playback, release the
  session, and reap audio children. If a process remains, run `vellum clean`
  and collect its details before retrying.

## Final hardware gate

Complete this matrix on a freshly imaged target before announcing support.
Attach redacted command output, call-site telemetry, route identity, and scalar
echo summaries to the implementation PR. Never attach credentials or PCM.

Run the gate in this order:

1. Record the board, RAM, OS, kernel architecture, Bun version, installed
   package version, PipeWire version, disk, swap, and login-linger state.
2. Install from the registry into a clean Bun prefix. Run installed-wrapper
   help, device discovery, and doctor without a source checkout on `PATH`.
3. Run direct local push-to-talk turns, including one front-door answer and one
   tool-requiring handoff. Confirm both call sites in redacted telemetry.
4. Run the same two turns against an authenticated Vellum-managed assistant.
   Confirm token minting and the Velay route without recording query strings.
5. Enable the exact AEC pair. Run loud speaker playback with no user speech,
   then speak over playback. Record route IDs and scalar echo summaries.
6. Exercise busy ownership, device unplug, network loss, `Ctrl+C`, `SIGTERM`,
   `SIGHUP`, and SSH loss. Check for stale sessions and orphaned audio children
   after every case.
7. Run a 30-minute mixed-turn soak and complete the resource and latency
   fields below.

| Gate                                                     | Result  | Evidence |
| -------------------------------------------------------- | ------- | -------- |
| Fresh `bun install -g vellum`                            | Pending |          |
| `voice doctor` on installed wrapper                      | Pending |          |
| Direct local push-to-talk conversation                   | Pending |          |
| Authenticated Vellum-managed conversation through Velay  | Pending |          |
| AEC open-mic conversation                                | Pending |          |
| Simple front-door answer confirmed by call site          | Pending |          |
| Tool-requiring main-agent handoff confirmed by call site | Pending |          |
| Another-session busy behavior                            | Pending |          |
| Device unplug and recovery                               | Pending |          |
| Network loss and reconnect                               | Pending |          |
| `Ctrl+C`, `SIGTERM`, `SIGHUP`, and SSH loss              | Pending |          |
| Loud-speaker playback causes no ghost turn               | Pending |          |
| Real speech still barges in during playback              | Pending |          |
| 30-minute soak                                           | Pending |          |

For the soak, record turn attempts and successes, ready latency, end-of-input
to first-audio latency, assistant and gateway RSS, swap growth, CPU load,
temperature, throttling, and orphaned `pw-record` or `pw-play` processes.

Support remains blocked until every claimed topology and interaction above has
a passing result.
