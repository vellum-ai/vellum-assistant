---
name: "SMS Setup"
description: "Set up and troubleshoot SMS messaging with guided Twilio configuration, compliance, and verification"
user-invocable: true
metadata: {"vellum": {"emoji": "\ud83d\udce8"}}
---

You are helping your user set up SMS messaging. This skill orchestrates Twilio setup, SMS-specific compliance, and end-to-end testing through a conversational flow.

## Step 1: Check Channel Readiness

First, check the current SMS channel readiness state by sending the `channel_readiness` IPC message:

```json
{
  "type": "channel_readiness",
  "action": "get",
  "channel": "sms"
}
```

Inspect the `channel_readiness_response`. The response contains `snapshots` with each channel's readiness state.

- If the SMS channel shows `ready: true` and all `localChecks` pass, skip to Step 3.
- If any local checks fail, proceed to Step 2 to fix the baseline.

## Step 2: Establish Baseline (Twilio Setup)

If SMS baseline is not ready (missing credentials, phone number, or ingress), load the `twilio-setup` skill to walk the user through the basics:

```
skill_load skill=twilio-setup
```

Tell the user: *"SMS needs Twilio configured first. I've loaded the Twilio setup guide — let's walk through it."*

After twilio-setup completes, re-check readiness:

```json
{
  "type": "channel_readiness",
  "action": "refresh",
  "channel": "sms"
}
```

If baseline is still not ready, report the specific failures and ask the user to address them before continuing.

## Step 3: Remote Compliance Check

Once baseline is ready, run a full readiness check including remote (Twilio API) checks:

```json
{
  "type": "channel_readiness",
  "action": "refresh",
  "channel": "sms",
  "includeRemote": true
}
```

Examine the remote check results:
- If all remote checks pass, proceed to Step 4.
- If compliance issues are found (e.g., toll-free verification needed), guide the user through the compliance flow:
  1. Check compliance status using the `twilio_config` IPC with `action: "sms_compliance_status"` (if available).
  2. If toll-free verification is needed, collect user information and submit via `twilio_config` with `action: "sms_submit_tollfree_verification"`.
  3. Report verification status and next steps.

**Note:** Compliance actions (sms_compliance_status, sms_submit_tollfree_verification, etc.) may not be available yet. If the IPC action is not recognized, tell the user: *"Compliance automation isn't available yet. You may need to check Twilio Console manually for toll-free verification status."*

### Data Collection for Verification (Individual-First)

When collecting information for toll-free verification:
- Assume the user is an **individual / sole proprietor** by default
- Do NOT ask for EIN, business registration number, or business registration authority
- Explain that Twilio labels some fields as "business" fields even for individual submitters
- Only collect what's required: business name (can be personal name), website (can be personal site), notification email, use case, message samples, opt-in info
- If Twilio rejects the submission requiring business registration, explain the situation and guide through the fallback path

## Step 4: Test Send

Run a test SMS to verify end-to-end delivery:

Tell the user: *"Let's send a test SMS to verify everything works. What phone number should I send the test to?"*

After the user provides a number, send a test message using the messaging tools:
- Use `messaging_send` with `platform: "sms"`, `conversation_id: "<phone number>"`, and a test message like "Test SMS from your Vellum assistant."
- Report the result honestly:
  - If the send succeeds: *"The message was accepted by Twilio. Note: 'accepted' means Twilio received it for delivery, not that it reached the handset yet. Delivery can take a few seconds to a few minutes."*
  - If the send fails: report the error and suggest troubleshooting steps

## Step 5: Final Status Report

After completing (or skipping) the test, present a clear summary:

**If everything passed:**
*"SMS is ready! Here's your setup status:"*
- Twilio credentials: configured
- Phone number: {number}
- Ingress: configured
- Compliance: {status}
- Test send: {result}

**If there are blockers:**
*"SMS setup is partially complete. Here's what still needs attention:"*
- List each blocker with the specific next action

## Troubleshooting

If the user returns to this skill after initial setup:
1. Always start with Step 1 (readiness check) to assess current state
2. Skip steps that are already complete
3. Focus on the specific issue the user is experiencing

Common issues:
- **"Messages not delivering"** — Check compliance status, verify the number isn't flagged
- **"Twilio error on send"** — Check credentials, phone number assignment, and ingress
- **"Trial account limitations"** — Explain that trial accounts can only send to verified numbers
