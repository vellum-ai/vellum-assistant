# Troubleshooting

## "Twilio credentials not configured"

Load the `twilio-setup` skill to store your Account SID and Auth Token.

## "Calls feature is disabled"

Run `assistant config set calls.enabled true`.

## "No public base URL configured"

First check whether this is a managed/platform assistant:

```bash
assistant platform status --json
```

If it reports an available platform assistant, do not install or start ngrok for Twilio. The gateway should use Velay, and `velayTunnel.connected` should become `true` after registration. If this is a local/self-hosted assistant without Velay, run the **public-ingress** skill to set up ngrok or another custom tunnel and configure `ingress.publicBaseUrl`.

## Call fails immediately after initiating

- Check that the phone number is in E.164 format
- Verify Twilio credentials are correct (wrong auth token causes API errors)
- On trial accounts, ensure the destination number is verified
- Check that the configured tunnel is still running. For ngrok, use `curl -s http://127.0.0.1:4040/api/tunnels`. For Velay, run `assistant platform status --json` and confirm `velayTunnel.connected` is `true`, or check gateway logs for `Velay tunnel registered`.

## Call connects but no audio / one-way audio

- The ConversationRelay WebSocket may not be connecting. If you are using ngrok or a custom tunnel, check that `ingress.publicBaseUrl` is correct and the tunnel is active. If you are using Velay, check `assistant platform status --json`; a 503 from `https://velay.../<assistant-id>/...` usually means the assistant tunnel is not connected or the gateway did not complete the WebSocket open, not that ngrok is required.
- Verify the assistant is running

## "Number not eligible for caller identity"

The user's phone number is not owned by or verified with the Twilio account. The number must be either purchased through Twilio or added as a verified caller ID at https://console.twilio.com/us1/develop/phone-numbers/manage/verified.

## "Per-call caller identity override is disabled"

The setting `calls.callerIdentity.allowPerCallOverride` is set to `false`, so per-call `caller_identity_mode` selection is not allowed. Re-enable overrides with `assistant config set calls.callerIdentity.allowPerCallOverride true`.

## Caller identity call fails on trial account

Twilio trial accounts can only place calls to verified numbers, regardless of caller identity mode. The user's phone number must also be verified with Twilio. Upgrade to a paid account or verify both the source and destination numbers.

## "This phone number is not allowed to be called"

Emergency numbers (911, 112, 999, 000, 110, 119) are permanently blocked for safety.

## ngrok tunnel URL changed

If you restarted ngrok, the public URL has changed. Update it:

```bash
assistant config set ingress.publicBaseUrl "<new-url>"
```

Or re-run the public-ingress skill to auto-detect and save the new URL.

Do not rotate ngrok to work around a managed Velay WebSocket failure. Fix the Velay tunnel state instead, or restart the assistant/gateway so it re-registers.

## Velay tunnel is not registering

- Confirm vembda passes the environment-appropriate `VELAY_BASE_URL` to the gateway container.
- Re-hatch or restart the assistant after changing the environment.
- Check gateway logs for `Velay tunnel connected` followed by `Velay tunnel registered`.
- If `VELAY_BASE_URL` is not set on a local/self-hosted assistant, the gateway does not start the Velay client. Use ngrok or another custom tunnel in `ingress.publicBaseUrl`.

## Local Twilio Velay smoke tests

- HTTP bridge: request `${VELAY_PUBLIC_BASE_URL}/<assistant-id>/healthz` and `${VELAY_PUBLIC_BASE_URL}/<assistant-id>/schema`. When testing a JSON webhook route under active development, POST a small JSON body through the same Velay public URL and confirm the gateway receives it.
- Synthetic WebSocket: connect a local WebSocket client to `${VELAY_PUBLIC_BASE_URL}/<assistant-id>/webhooks/twilio/relay?callSessionId=session-123&token=<edge-token>` and confirm the upgrade reaches the gateway.
- Real Twilio call: wait for the gateway to register with Velay, then place a call and confirm Twilio fetches `/webhooks/twilio/voice` and opens the relay or media-stream WebSocket through the Velay URL.

## Call drops after 30 seconds of silence

The system has a 30-second silence timeout. If nobody speaks for 30 seconds during normal conversation, the agent will ask "Are you still there?" This is expected behavior. During guardian wait states (inbound access-request wait or in-call guardian consultation wait), this generic silence nudge is suppressed - the guardian-wait heartbeat messaging is used instead.

## Call quality sounds off

- Verify `services.tts.providers.elevenlabs.voiceId` is set to a valid ElevenLabs voice ID
- Ask for the desired voice style again and try a different voice selection

## Twilio says "application error" right after answer

- This often means ConversationRelay rejected voice configuration after TwiML fetch
- Keep `services.tts.providers.elevenlabs.voiceModelId` empty first (bare `voiceId` mode)
- If you set `voiceModelId`, try clearing it and retesting:
  `assistant config set services.tts.providers.elevenlabs.voiceModelId ""`
