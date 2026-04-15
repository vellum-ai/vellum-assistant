#!/usr/bin/env bash
#
# PulseAudio setup for the meet-bot container.
#
# Creates the virtual audio topology the bot needs to participate in a Google
# Meet call:
#
#   TTS output  ->  bot_out (null-sink)
#                    \_ bot_out.monitor
#                         \_ bot_mic (virtual-source, fed into Chrome as mic)
#
#   Meet audio  ->  meet_capture (null-sink; its .monitor is captured for STT)
#
# The script is idempotent — each `pactl load-module` is guarded by a check
# against the existing sink/source list so repeated invocations are no-ops.
#
# Intended to be invoked once at container start. See `pulse.ts` for the
# TypeScript wrapper that shells out to this script.

set -euo pipefail

# Start the PulseAudio daemon in the background if it is not already running.
# `--exit-idle-time=-1` prevents it from exiting when no clients are connected,
# which happens briefly between the daemon launching and Chrome attaching.
if ! pactl info >/dev/null 2>&1; then
  pulseaudio --start --exit-idle-time=-1
fi

# Wait for the daemon to become reachable. `pulseaudio --start` returns before
# the socket is necessarily accepting connections, so poll pactl briefly.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if pactl info >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

if ! pactl info >/dev/null 2>&1; then
  echo "pulse-setup: PulseAudio daemon did not come up" >&2
  exit 1
fi

# ---- Helpers --------------------------------------------------------------

sink_exists() {
  pactl list short sinks | awk '{print $2}' | grep -Fxq "$1"
}

source_exists() {
  pactl list short sources | awk '{print $2}' | grep -Fxq "$1"
}

# ---- bot_out: null-sink the bot's TTS output is written into --------------
if ! sink_exists bot_out; then
  pactl load-module module-null-sink \
    sink_name=bot_out \
    sink_properties=device.description=BotOutput >/dev/null
fi

# ---- bot_mic: virtual-source Chrome uses as its microphone ----------------
# Master is bot_out.monitor so whatever is played to bot_out shows up on
# bot_mic as captured audio.
if ! source_exists bot_mic; then
  pactl load-module module-virtual-source \
    source_name=bot_mic \
    master=bot_out.monitor \
    source_properties=device.description=BotMic >/dev/null
fi

# ---- meet_capture: null-sink Chrome's output is routed into ---------------
# The monitor of this sink is what Phase 3 / PR 15 taps for STT.
if ! sink_exists meet_capture; then
  pactl load-module module-null-sink \
    sink_name=meet_capture \
    sink_properties=device.description=MeetCapture >/dev/null
fi

# ---- Defaults -------------------------------------------------------------
# Chrome picks up the default source as its microphone and the default sink
# as its playback target. Setting them here means we don't have to configure
# the browser separately.
pactl set-default-source bot_mic
pactl set-default-sink meet_capture

exit 0
