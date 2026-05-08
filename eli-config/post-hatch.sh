#!/usr/bin/env bash
#
# eli-config/post-hatch.sh — One-shot configuration for "Eli" once `vellum hatch`
# has finished. Idempotent — safe to re-run.
#
# Run it AFTER:
#   1. You've exported MINIMAX_API_KEY in your shell.
#   2. You've run `vellum hatch --name eli ...` and the daemon is up
#      (`vellum ps` shows it healthy).
#
# Optional env vars it picks up if exported (silently skipped otherwise):
#   - SLACK_MCP_XOXP_TOKEN  → swapped into the slack MCP server config and the
#                              server is flipped from disabled -> enabled.
#   - ELEVENLABS_API_KEY    → Jarvis-quality TTS voice.
#   - DEEPGRAM_API_KEY      → realtime STT for the always-on voice loop.
#   - PICOVOICE_ACCESS_KEY  → wake-word detection (free tier at
#                              https://console.picovoice.ai/).
#   - ANTHROPIC_API_KEY     → optional secondary brain.
#   - OPENAI_API_KEY        → optional secondary brain.

set -euo pipefail

info()  { echo "==> $*"; }
warn()  { echo "warning: $*" >&2; }
error() { echo "error: $*" >&2; exit 1; }

if ! command -v vellum &>/dev/null; then
  export PATH="${HOME}/.bun/bin:${PATH}"
fi
command -v vellum &>/dev/null || error "vellum CLI not on PATH. Re-run ./setup.sh from the repo root."

ASSISTANT_NAME="${ELI_ASSISTANT_NAME:-eli}"
LOCKFILE="${HOME}/.vellum.lock.json"
ELI_WORKSPACE="${HOME}/.local/share/vellum/assistants/${ASSISTANT_NAME}/.vellum/workspace"
ELI_CONFIG="${ELI_WORKSPACE}/config.json"

[ -f "${LOCKFILE}" ] || error "No assistants found at ${LOCKFILE}. Run 'vellum hatch --name ${ASSISTANT_NAME} ...' first."
[ -f "${ELI_CONFIG}" ] || error "No config at ${ELI_CONFIG}. Was '${ASSISTANT_NAME}' actually hatched?"

GATEWAY_URL="$(
  bun -e "
    const data = JSON.parse(await Bun.file('${LOCKFILE}').text());
    const e = (data.assistants ?? []).find(a => a.assistantId === '${ASSISTANT_NAME}');
    if (!e) { process.exit(1); }
    process.stdout.write(e.runtimeUrl ?? e.localUrl ?? '');
  "
)" || error "Couldn't find assistant '${ASSISTANT_NAME}' in lockfile. Set ELI_ASSISTANT_NAME=<your-name> if you hatched under a different name."

[ -n "${GATEWAY_URL}" ] || error "Assistant '${ASSISTANT_NAME}' has no runtime URL. Try 'vellum wake ${ASSISTANT_NAME}'."

BEARER_TOKEN="$(
  bun -e "
    const data = JSON.parse(await Bun.file('${LOCKFILE}').text());
    const e = (data.assistants ?? []).find(a => a.assistantId === '${ASSISTANT_NAME}');
    process.stdout.write(e?.bearerToken ?? '');
  "
)" || true

info "Targeting assistant '${ASSISTANT_NAME}' at ${GATEWAY_URL}"

# ---------------------------------------------------------------------------
# Helper: store a credential via the gateway /v1/secrets endpoint
# ---------------------------------------------------------------------------

store_secret() {
  local secret_name="$1"
  local secret_value="$2"
  local headers=(-H 'Content-Type: application/json' -H 'Accept: application/json')
  if [ -n "${BEARER_TOKEN}" ]; then
    headers+=(-H "Authorization: Bearer ${BEARER_TOKEN}")
  fi
  local body
  body="$(VAULT_VALUE="${secret_value}" bun -e "
    const out = JSON.stringify({
      type: 'credential',
      name: '${secret_name}',
      value: process.env.VAULT_VALUE,
    });
    process.stdout.write(out);
  ")"
  local http_status
  http_status="$(
    curl -sS -o /dev/null -w '%{http_code}' \
      -X POST "${GATEWAY_URL}/v1/secrets" \
      "${headers[@]}" \
      -d "${body}"
  )"
  if [ "${http_status}" -ge 200 ] && [ "${http_status}" -lt 300 ]; then
    info "Stored ${secret_name} in secure credential store."
  else
    warn "Failed to store ${secret_name} (HTTP ${http_status})."
  fi
}

# ---------------------------------------------------------------------------
# Helper: rewrite eli's config.json in place via Bun (preserves formatting)
# ---------------------------------------------------------------------------

patch_eli_config() {
  local script="$1"
  bun -e "
    const path = '${ELI_CONFIG}';
    const data = JSON.parse(await Bun.file(path).text());
    ${script}
    await Bun.write(path, JSON.stringify(data, null, 2) + '\\n');
  "
}

# ---------------------------------------------------------------------------
# 1. MiniMax — Eli's brain (required)
# ---------------------------------------------------------------------------

if [ -z "${MINIMAX_API_KEY:-}" ]; then
  error "MINIMAX_API_KEY is not set. Export it first:
    export MINIMAX_API_KEY=\"sk-...your-key...\""
fi
store_secret MINIMAX_API_KEY "${MINIMAX_API_KEY}"

if [ -n "${MINIMAX_BASE_URL:-}" ]; then
  info "Note: MINIMAX_BASE_URL=${MINIMAX_BASE_URL} is set — add it to your shell rc to make it persistent."
fi

# ---------------------------------------------------------------------------
# 2. Optional secondary credentials (only stored if exported)
# ---------------------------------------------------------------------------

[ -n "${ELEVENLABS_API_KEY:-}" ] && store_secret ELEVENLABS_API_KEY  "${ELEVENLABS_API_KEY}"
[ -n "${DEEPGRAM_API_KEY:-}" ]   && store_secret DEEPGRAM_API_KEY    "${DEEPGRAM_API_KEY}"
[ -n "${PICOVOICE_ACCESS_KEY:-}" ] && store_secret PICOVOICE_ACCESS_KEY "${PICOVOICE_ACCESS_KEY}"
[ -n "${ANTHROPIC_API_KEY:-}" ]  && store_secret ANTHROPIC_API_KEY   "${ANTHROPIC_API_KEY}"
[ -n "${OPENAI_API_KEY:-}" ]     && store_secret OPENAI_API_KEY      "${OPENAI_API_KEY}"

# ---------------------------------------------------------------------------
# 3. Wire the slack MCP server token if present
# ---------------------------------------------------------------------------

if [ -n "${SLACK_MCP_XOXP_TOKEN:-}" ]; then
  ELI_SLACK_TOKEN_INPUT="${SLACK_MCP_XOXP_TOKEN}" patch_eli_config "
    const slack = data?.mcp?.servers?.slack;
    if (slack?.transport?.type === 'stdio') {
      slack.transport.env = {
        ...(slack.transport.env ?? {}),
        SLACK_MCP_XOXP_TOKEN: process.env.ELI_SLACK_TOKEN_INPUT,
      };
      slack.enabled = true;
    }
  "
  info "Wired SLACK_MCP_XOXP_TOKEN into the slack MCP server and enabled it."
  curl -sS -o /dev/null -X POST "${GATEWAY_URL}/v1/mcp/reload" \
    -H "Content-Type: application/json" \
    ${BEARER_TOKEN:+-H "Authorization: Bearer ${BEARER_TOKEN}"} || true
else
  warn "SLACK_MCP_XOXP_TOKEN not set — the slack MCP server stays disabled. Either set it and re-run, or use 'assistant mcp add slack ...' once you have a token."
fi

# ---------------------------------------------------------------------------
# 4. Coerce voice config booleans/numbers (vellum hatch --config writes
#    everything as strings; some Zod schemas reject string-typed booleans).
# ---------------------------------------------------------------------------

patch_eli_config "
  const voice = data.voice;
  if (voice) {
    if (typeof voice.alwaysOn === 'string') voice.alwaysOn = voice.alwaysOn === 'true';
    const ww = voice.wakeWord;
    if (ww) {
      if (typeof ww.enabled === 'string') ww.enabled = ww.enabled === 'true';
      if (typeof ww.runOnClient === 'string') ww.runOnClient = ww.runOnClient === 'true';
    }
    const vad = voice.vad;
    if (vad) {
      for (const k of ['silenceMs', 'minUtteranceMs', 'maxUtteranceMs']) {
        if (typeof vad[k] === 'string') vad[k] = Number(vad[k]);
      }
    }
  }
"
info "Coerced voice config booleans/numbers from strings."

# ---------------------------------------------------------------------------
# 5. Print the runbook for steps that can't be scripted
# ---------------------------------------------------------------------------

cat <<'EOF'

────────────────────────────────────────────────────────────────────
Eli is configured. Recommended next steps (these need your hands):

  # Talk to Eli for the first time. The first conversation is where
  # her personality (SOUL.md / NOW.md) gets written.
  vellum client eli

  # Voice — ask Eli inside the chat:
  #   "Set me up for voice with push-to-talk and ElevenLabs."
  # She'll walk through mic permission + PTT key + ElevenLabs voice pick.

  # Slack — if you didn't set SLACK_MCP_XOXP_TOKEN above, get one:
  #   https://github.com/korotovsky/slack-mcp-server#readme
  # Then re-run this script with it exported, OR ask Eli:
  #   "Wire my slack token <xoxp-...> and turn the slack MCP server on."

  # Tasks — just ask Eli: "Add 'review Q2 metrics' to my tasks."

  # Proactivity — Eli's heartbeat checks in hourly by default. Tune via:
  #   "Adjust your heartbeat to every 4 hours during work."

  # Tauri HUD — clients/tauri/. See clients/tauri/README.md to launch.

────────────────────────────────────────────────────────────────────
EOF
