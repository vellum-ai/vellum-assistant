# Troubleshooting

## "Twilio credentials not configured"

Load the `twilio-setup` skill to store your Account SID and Auth Token.

## "Calls feature is disabled"

Run `assistant config set calls.enabled true`.

## "No public base URL configured"

Run the **public-ingress** skill to set up ngrok and configure `ingress.publicBaseUrl`.

## Call fails immediately after initiating

- Check that the phone number is in E.164 format
- Verify Twilio credentials are correct (wrong auth token causes API errors)
- On trial accounts, ensure the destination number is verified
- Check that the ngrok tunnel is still running (`curl -s http://127.0.0.1:4040/api/tunnels`)

## Call connects but no audio / one-way audio

- The ConversationRelay WebSocket may not be connecting. Check that `ingress.publicBaseUrl` is correct and the tunnel is active
- Verify the assistant runtime is running

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

## Call drops after 30 seconds of silence

The system has a 30-second silence timeout. If nobody speaks for 30 seconds during normal conversation, the agent will ask "Are you still there?" This is expected behavior. During guardian wait states (inbound access-request wait or in-call guardian consultation wait), this generic silence nudge is suppressed — the guardian-wait heartbeat messaging is used instead.

## Call quality sounds off

- Verify `elevenlabs.voiceId` is set to a valid ElevenLabs voice ID
- Ask for the desired voice style again and try a different voice selection

## Twilio says "application error" right after answer

- This often means ConversationRelay rejected voice configuration after TwiML fetch
- Keep `elevenlabs.voiceModelId` empty first (bare `voiceId` mode)
- If you set `voiceModelId`, try clearing it and retesting:
  `assistant config set elevenlabs.voiceModelId ""`
