---
name: "Twilio Setup"
description: "Configure Twilio credentials and phone numbers for voice calls and SMS messaging"
user-invocable: true
includes: ["public-ingress"]
metadata: {"vellum": {"emoji": "\ud83d\udcf1"}}
---

You are helping your user configure Twilio for voice calls and SMS messaging. Twilio is the shared telephony provider for both the **phone-calls** and **SMS messaging** capabilities. When this skill is invoked, walk through each step below using the `twilio_config` IPC contract and existing tools.

## Overview

This skill manages the full Twilio lifecycle:
- **Credential storage** — Account SID and Auth Token
- **Phone number provisioning** — Buy a new number directly from Twilio
- **Phone number assignment** — Assign an existing Twilio number to the assistant
- **Status checking** — Verify credentials and assigned number

All operations go through the `twilio_config` IPC handler on the daemon, which validates inputs, stores credentials securely, and manages phone number state.

## Step 1: Check Current Configuration

First, check whether Twilio is already configured by sending the `twilio_config` IPC message with `action: "get"`:

```json
{
  "type": "twilio_config",
  "action": "get"
}
```

The daemon returns a `twilio_config_response` with:
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

After both credentials are collected, retrieve them from secure storage and pass them to the daemon:

```json
{
  "type": "twilio_config",
  "action": "set_credentials",
  "accountSid": "<value from credential_store for twilio/account_sid>",
  "authToken": "<value from credential_store for twilio/auth_token>"
}
```

Both `accountSid` and `authToken` are required — the daemon validates the credentials against the Twilio API before storing them. If credentials are invalid, the daemon returns an error. Tell the user and ask them to re-enter via the secure prompt.

## Step 3: Get a Phone Number

The assistant needs a phone number to make calls and send SMS. There are two paths:

### Option A: Provision a New Number

If the user wants to buy a new number through Twilio, send:

```json
{
  "type": "twilio_config",
  "action": "provision_number",
  "areaCode": "415",
  "country": "US"
}
```

- `areaCode` is optional — ask the user if they have a preferred area code
- `country` defaults to `"US"` — ask if they want a different country (ISO 3166-1 alpha-2)

The daemon provisions the number via the Twilio API, automatically assigns it to the assistant (persisting to both secure storage and config), and configures Twilio webhooks (voice, status callback, SMS) if a public ingress URL is available. The response includes the new `phoneNumber`. No separate `assign_number` call is needed.

**Webhook auto-configuration:** When `ingress.publicBaseUrl` is configured, the daemon automatically sets the following webhooks on the Twilio phone number:
- Voice webhook: `{publicBaseUrl}/webhooks/twilio/voice`
- Voice status callback: `{publicBaseUrl}/webhooks/twilio/status`
- SMS webhook: `{publicBaseUrl}/webhooks/twilio/sms`

If ingress is not yet configured, webhook setup is skipped gracefully — the number is still assigned and usable once ingress is set up later.

**Trial account note:** Twilio trial accounts come with one free phone number. Check "Active Numbers" in the Twilio Console first before provisioning.

### Option B: Assign an Existing Number

If the user already has a Twilio phone number, first list available numbers:

```json
{
  "type": "twilio_config",
  "action": "list_numbers"
}
```

The response includes a `numbers` array with each number's `phoneNumber`, `friendlyName`, and `capabilities` (voice, SMS). Present these to the user and let them choose.

Then assign the chosen number:

```json
{
  "type": "twilio_config",
  "action": "assign_number",
  "phoneNumber": "+14155551234"
}
```

The phone number must be in E.164 format. Like `provision_number`, `assign_number` also auto-configures Twilio webhooks when a public ingress URL is available.

### Option C: Manual Entry

If the user wants to enter a number directly (e.g., they know it already), store it via credential store:

```
credential_store action=store service=twilio field=phone_number value=+14155551234
```

Then assign it through the IPC:

```json
{
  "type": "twilio_config",
  "action": "assign_number",
  "phoneNumber": "+14155551234"
}
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

Webhook URLs are automatically configured on the Twilio phone number when `provision_number` or `assign_number` is called with a valid ingress URL. No manual Twilio Console webhook configuration is needed.

## Step 5: Verify Setup

After configuration, verify by sending `twilio_config` with `action: "get"` again.

Confirm:
- `hasCredentials` is `true`
- `phoneNumber` is set to the expected number

Tell the user: **"Twilio is configured. Your assistant's phone number is {phoneNumber}. This number is used for both voice calls and SMS messaging."**

## Step 5.5: Guardian Verification (SMS)

Now link the user's phone number as the trusted SMS guardian for this assistant. Tell the user: "Now let's verify your guardian identity for SMS. This links your phone number as the trusted guardian for SMS messaging."

1. Send the `guardian_verification` IPC message with `action: "create_challenge"` and `channel: "sms"`:

```json
{
  "type": "guardian_verification",
  "action": "create_challenge",
  "channel": "sms"
}
```

2. The daemon returns a `guardian_verification_response` with `success: true`, `secret`, and `instruction`. Display the instruction to the user. It will look like: "Send `/guardian_verify <secret>` to your bot via SMS within 10 minutes."

3. Wait for the user to confirm they have sent the verification code via SMS to the assistant's phone number.

4. Check verification status by sending `guardian_verification` with `action: "status"` and `channel: "sms"`:

```json
{
  "type": "guardian_verification",
  "action": "status",
  "channel": "sms"
}
```

5. If `bound` is `true`: "Guardian verified! Your phone number is now the trusted SMS guardian."

6. If `bound` is `false` and the user claims they sent the code: "The verification doesn't appear to have succeeded. Let's generate a new challenge." Repeat from substep 1.

**Note:** Guardian verification is optional but recommended. If the user declines or wants to skip, proceed to Step 6 without blocking.

To re-check guardian status later, send `guardian_verification` with `action: "status"` and `channel: "sms"`.

Report the guardian verification result: **"Guardian identity: {verified | not configured}."**

## Step 6: Enable Features

Now that Twilio is configured, the user can enable the features that depend on it:

**For voice calls:**
```bash
vellum config set calls.enabled true
```

**For SMS messaging:**
SMS is available automatically once Twilio is configured — no additional feature flag is needed.

## Clearing Credentials

If the user wants to disconnect Twilio, send:

```json
{
  "type": "twilio_config",
  "action": "clear_credentials"
}
```

This removes the stored Account SID and Auth Token. Your phone number assignment will be preserved. Voice calls and SMS will stop working until credentials are reconfigured.

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
- Use `list_numbers` to see available numbers
- Ensure the number is in E.164 format (`+` followed by country code and number)
