---
name: "twilio-setup"
description: "Configure Twilio credentials and phone numbers for voice calls and SMS messaging"
compatibility: "Requires public ingress for Twilio webhooks (voice, SMS, status callbacks)"
metadata:
  emoji: "\ud83d\udcf1"
  vellum:
    user-invocable: true
    credential-setup-for: "twilio"
---

You are helping your user configure Twilio for voice calls and SMS messaging. Twilio is the shared telephony provider for both the **phone-calls** and **SMS messaging** capabilities. When this skill is invoked, walk through each step below using the Twilio HTTP control-plane endpoints and existing tools.

## Overview

This skill manages the full Twilio lifecycle:

- **Credential storage** — Account SID and Auth Token
- **Phone number provisioning** — Buy a new number directly from Twilio
- **Phone number assignment** — Assign an existing Twilio number to the assistant
- **Status checking** — Verify credentials and assigned number

Mutating operations use Twilio HTTP control-plane endpoints on the gateway. Status/list retrieval uses `vellum integrations ...` CLI reads.

### Multi-Assistant Setups

In a multi-assistant environment (multiple assistants sharing the same runtime), some actions are **assistant-scoped** while others are **global** (shared across all assistants):

**Global actions** (ignore `assistantId` — credentials are shared across all assistants):

- `POST /v1/integrations/twilio/credentials` — Stores Account SID and Auth Token in global secure storage (`credential:twilio:*` keys). All assistants share the same Twilio account credentials.
- `DELETE /v1/integrations/twilio/credentials` — Removes the globally stored Account SID and Auth Token. This affects all assistants.

**Assistant-scoped actions** (use `assistantId` query parameter to scope phone number configuration per assistant):

- `GET /v1/integrations/twilio/config` — Returns the phone number assigned to the specified assistant.
- `POST /v1/integrations/twilio/numbers/assign` — Assigns a phone number to a specific assistant via the per-assistant mapping.
- `POST /v1/integrations/twilio/numbers/provision` — Provisions a new number and assigns it to the specified assistant.
- `GET /v1/integrations/twilio/numbers` — Lists all phone numbers on the shared Twilio account (uses global credentials).

Include `assistantId` as a query parameter in assistant-scoped requests whenever:

- Multiple assistants share the same Twilio account but use different phone numbers
- You want to ensure configuration changes only affect a specific assistant
- The user has explicitly selected or referenced a particular assistant

All HTTP examples below include the optional `assistantId` query parameter in assistant-scoped requests. Omit it in single-assistant setups. For global actions (credentials), the `assistantId` parameter is accepted but ignored.

## Step 1: Check Current Configuration

First, check whether Twilio is already configured:

```bash
vellum integrations twilio config --json
```

The response includes:

- `hasCredentials` — whether Account SID and Auth Token are stored
- `phoneNumber` — the currently assigned phone number (if any)

If both are present, tell the user Twilio is already configured and offer to show the current status or reconfigure.

## Step 2: Collect and Store Credentials

If credentials are not yet stored, guide the user through Twilio account setup:

1. Tell the user: **"You'll need a Twilio account. Sign up at https://www.twilio.com/try-twilio — it's free to start and includes trial credit."**
2. Once they have an account, they need two pieces of information:
   - **Account SID** — found on the Twilio Console dashboard at https://console.twilio.com
   - **Auth Token** — found on the same dashboard (click "Show" to reveal it)

**IMPORTANT — Secure credential collection only:** Never use credentials pasted in plaintext chat. Always collect credentials through the secure credential prompt flow:

- Call `credential_store` with `action: "prompt"`, `service: "twilio"`, `field: "account_sid"`, `label: "Twilio Account SID"`, `description: "Enter your Account SID from the Twilio Console dashboard"`, and `placeholder: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"`.
- Call `credential_store` with `action: "prompt"`, `service: "twilio"`, `field: "auth_token"`, `label: "Twilio Auth Token"`, `description: "Enter your Auth Token from the Twilio Console dashboard"`, and `placeholder: "your_auth_token"`.

After both credentials are collected, retrieve them from secure storage and send them to the gateway:

```bash
curl -s -X POST "$INTERNAL_GATEWAY_BASE_URL/v1/integrations/twilio/credentials" \
  -H "Authorization: Bearer $GATEWAY_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"accountSid":"<value from credential_store for twilio/account_sid>","authToken":"<value from credential_store for twilio/auth_token>"}'
```

Both `accountSid` and `authToken` are required — the endpoint validates the credentials against the Twilio API before storing them. If credentials are invalid, the response returns an error. Tell the user and ask them to re-enter via the secure prompt.

**Note:** Setting credentials is a global operation — credentials are stored once and shared across all assistants. The `assistantId` parameter is accepted but ignored.

## Step 3: Get a Phone Number

The assistant needs a phone number to make calls and send SMS. There are two paths:

### Option A: Provision a New Number

If the user wants to buy a new number through Twilio:

```bash
curl -s -X POST "$INTERNAL_GATEWAY_BASE_URL/v1/integrations/twilio/numbers/provision" \
  -H "Authorization: Bearer $GATEWAY_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"country":"US","areaCode":"415"}'
```

- `areaCode` is optional — ask the user if they have a preferred area code
- `country` defaults to `"US"` — ask if they want a different country (ISO 3166-1 alpha-2)

The endpoint provisions the number via the Twilio API, automatically assigns it to the assistant (persisting to both secure storage and config), and configures Twilio webhooks (voice, status callback, SMS) if a public ingress URL is available. The response includes the new `phoneNumber`. No separate assign call is needed.

**Webhook auto-configuration:** When `ingress.publicBaseUrl` is configured, the endpoint automatically sets the following webhooks on the Twilio phone number:

- Voice webhook: `{publicBaseUrl}/webhooks/twilio/voice`
- Voice status callback: `{publicBaseUrl}/webhooks/twilio/status`
- SMS webhook: `{publicBaseUrl}/webhooks/twilio/sms`

If ingress is not yet configured, webhook setup is skipped gracefully — the number is still assigned and usable once ingress is set up later.

**Trial account note:** Twilio trial accounts come with one free phone number. Check "Active Numbers" in the Twilio Console first before provisioning.

### Option B: Assign an Existing Number

If the user already has a Twilio phone number, first list available numbers:

```bash
vellum integrations twilio numbers --json
```

The response includes a `numbers` array with each number's `phoneNumber`, `friendlyName`, and `capabilities` (voice, SMS). Present these to the user and let them choose.

Then assign the chosen number:

```bash
curl -s -X POST "$INTERNAL_GATEWAY_BASE_URL/v1/integrations/twilio/numbers/assign" \
  -H "Authorization: Bearer $GATEWAY_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber":"+14155551234"}'
```

The phone number must be in E.164 format. Like provisioning, assigning also auto-configures Twilio webhooks when a public ingress URL is available.

### Option C: Manual Entry

If the user wants to enter a number directly (e.g., they know it already), store it via credential store:

```
credential_store action=store service=twilio field=phone_number value=+14155551234
```

Then assign it through the gateway:

```bash
curl -s -X POST "$INTERNAL_GATEWAY_BASE_URL/v1/integrations/twilio/numbers/assign" \
  -H "Authorization: Bearer $GATEWAY_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber":"+14155551234"}'
```

## Step 4: Set Up Public Ingress

Twilio needs a publicly reachable URL for voice webhooks, ConversationRelay WebSocket, and SMS delivery reports. The **public-ingress** skill handles this via ngrok.

Check if ingress is already configured:

```bash
vellum config get ingress.publicBaseUrl
vellum config get ingress.enabled
```

If not configured, load and run the public-ingress skill:

```
skill_load skill=public-ingress
```

**Twilio webhook endpoints (auto-configured on provision/assign):**

- Voice webhook: `{publicBaseUrl}/webhooks/twilio/voice`
- Voice status callback: `{publicBaseUrl}/webhooks/twilio/status`
- ConversationRelay WebSocket: `{publicBaseUrl}/webhooks/twilio/relay` (wss://)
- SMS webhook: `{publicBaseUrl}/webhooks/twilio/sms`

Webhook URLs are automatically configured on the Twilio phone number when provisioning or assigning a number with a valid ingress URL. No manual Twilio Console webhook configuration is needed.

## Step 5: Verify Setup

After configuration, verify by checking the config endpoint again.

```bash
vellum integrations twilio config --json
```

Confirm:

- `hasCredentials` is `true`
- `phoneNumber` is set to the expected number

Tell the user: **"Twilio is configured. Your assistant's phone number is {phoneNumber}. This number is used for both voice calls and SMS messaging."**

## Step 5.5: Guardian Verification (Voice)

Now link the user's phone number as the trusted voice guardian. Tell the user: "Now let's verify your guardian identity for voice. This links your phone number so the assistant can verify inbound callers."

Load the **guardian-verify-setup** skill to handle the verification flow:

- Call `skill_load` with `skill: "guardian-verify-setup"` to load the dependency skill.

When invoking the skill, indicate the channel is `voice`. The guardian-verify-setup skill manages the full outbound verification flow, including:

- Collecting the user's phone number as the destination (accepts any common format -- the API normalizes to E.164)
- Starting the outbound verification session via the gateway endpoint `POST /v1/integrations/guardian/outbound/start` with `channel: "voice"`
- Calling the phone number and providing a code for the user to enter via their phone's keypad
- Proactively polling for completion (voice auto-check) so the user gets instant confirmation
- Checking guardian status to confirm the binding was created
- Handling resend, cancel, and error cases

Tell the user: _"I've loaded the guardian verification guide. It will walk you through linking your phone number as the trusted voice guardian."_

After the guardian-verify-setup skill completes (or the user skips), continue to Step 6.

**Note:** Guardian verification is optional but recommended. If the user declines or wants to skip, proceed to Step 6 without blocking.

To re-check guardian status later:

```bash
vellum integrations guardian status --channel voice --json
```

## Step 6: Enable Features

Now that Twilio is configured, the user can enable the features that depend on it:

**For voice calls:**

```bash
vellum config set calls.enabled true
```

**For SMS messaging:**
SMS is available automatically once Twilio is configured — no additional feature flag is needed.

## Clearing Credentials

If the user wants to disconnect Twilio:

```bash
curl -s -X DELETE "$INTERNAL_GATEWAY_BASE_URL/v1/integrations/twilio/credentials" \
  -H "Authorization: Bearer $GATEWAY_AUTH_TOKEN"
```

This removes the stored Account SID and Auth Token. Phone number assignments are preserved. Voice calls and SMS will stop working until credentials are reconfigured.

**Note:** Clearing credentials is a global operation — it removes credentials for all assistants, not just the current one. The `assistantId` parameter is accepted but ignored. In multi-assistant setups, warn the user that clearing credentials will affect all assistants sharing this Twilio account.

## Troubleshooting

### "Twilio credentials not configured"

Run Steps 2 and 3 to store credentials and assign a phone number.

### "No phone number assigned"

Run Step 3 to provision or assign a phone number.

### Phone number provisioning fails

- Verify Twilio credentials are correct
- On trial accounts, you may already have a free number — check "Active Numbers" in the Console
- Ensure the Twilio account has sufficient balance for paid accounts

### Calls/SMS fail after setup

- Verify public ingress is running (`ingress.publicBaseUrl` must be set)
- For calls, ensure `calls.enabled` is `true`
- On trial accounts, outbound calls and SMS can only reach verified numbers

### "Number not found" when assigning

- The number must be owned by the same Twilio account
- Use the list numbers endpoint to see available numbers
- Ensure the number is in E.164 format (`+` followed by country code and number)
