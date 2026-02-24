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
- If compliance issues are found (e.g., toll-free verification needed), guide the user through the compliance flow.

### Toll-Free Verification Submission

When the remote check returns `toll_free_verification` as a failing check, the assistant must submit verification directly to the Twilio API. The daemon does not yet have an IPC action for this, so use the Twilio REST API directly.

**Prerequisites:** The assistant needs the Account SID and Auth Token. These are stored in daemon secure storage and can be accessed by importing `getSecureKey` from the daemon's `security/secure-keys` module:

```typescript
import { getSecureKey } from "./src/security/secure-keys.js";
const accountSid = getSecureKey("credential:twilio:account_sid");
const authToken = getSecureKey("credential:twilio:auth_token");
```

**Step 3a: Look up the phone number SID.** The toll-free verification API requires the phone number's SID (format `PNxxxx`), not the E.164 number itself:

```
GET https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/IncomingPhoneNumbers.json?PhoneNumber={E.164 number}
```

Extract the `sid` field from the matching number in `incoming_phone_numbers`.

**Step 3b: Check for existing verifications.** Before submitting, check if a verification already exists:

```
GET https://messaging.twilio.com/v1/Tollfree/Verifications
```

If a verification already exists for this number, report its status to the user and skip submission.

**Step 3c: Check Trust Hub profile assignments.** Twilio auto-attaches toll-free numbers to their assigned Trust Hub Customer Profile. The verification API rejects submissions when the number is attached to a Primary Customer Profile (PCP). It requires either no profile, a Starter profile, or a Secondary Customer Profile (SCP).

Check if the number is assigned to a profile:

```
GET https://trusthub.twilio.com/v1/CustomerProfiles?PageSize=50
```

For each profile, check `ChannelEndpointAssignments`:

```
GET https://trusthub.twilio.com/v1/CustomerProfiles/{ProfileSid}/ChannelEndpointAssignments?PageSize=50
```

If the number is assigned to a Primary profile:
1. **Tell the user** the number is linked to a Primary Customer Profile, which blocks toll-free verification.
2. **Offer two options:**
   - **Option A:** Remove the number from the Primary profile (DELETE the ChannelEndpointAssignment), then resubmit. Warn that this may affect other services tied to that profile.
   - **Option B:** Wait for the Starter profile to be approved (if one exists and is `in-review`), then link the number to that profile instead.
3. **Do not silently retry.** The same error will recur until the profile assignment is resolved.

**Step 3d: Collect user information.** Collect the following from the user (assume individual/sole proprietor by default):

| Field | API Parameter | Notes |
|---|---|---|
| Name | `BusinessName` | Can be personal name |
| Business type | `BusinessType` | Use `SOLE_PROPRIETOR` for individuals. Valid values: `PRIVATE_PROFIT`, `PUBLIC_PROFIT`, `SOLE_PROPRIETOR`, `NON_PROFIT`, `GOVERNMENT` |
| Website | `BusinessWebsite` | LinkedIn or personal site is fine |
| Street address | `BusinessStreetAddress` | |
| City | `BusinessCity` | |
| State | `BusinessStateProvinceRegion` | |
| Zip | `BusinessPostalCode` | |
| Country | `BusinessCountry` | Two-letter ISO code, e.g. `US` |
| Notification email | `NotificationEmail` | Where Twilio sends status updates |
| Contact phone | `BusinessContactPhone` | E.164 format |
| Contact first name | `BusinessContactFirstName` | |
| Contact last name | `BusinessContactLastName` | |
| Contact email | `BusinessContactEmail` | |
| Use case category | `UseCaseCategories` | e.g. `ACCOUNT_NOTIFICATIONS` |
| Use case summary | `UseCaseSummary` | Plain English description |
| Message volume | `MessageVolume` | Estimated monthly messages, e.g. `100` |
| Sample message | `ProductionMessageSample` | A realistic example message |
| Opt-in type | `OptInType` | `VERBAL`, `WEB_FORM`, `PAPER_FORM`, `VIA_TEXT`, `MOBILE_QR_CODE` |
| Opt-in image URL | `OptInImageUrls` | URL showing opt-in mechanism (can be website URL) |

Do NOT ask for EIN, business registration number, or business registration authority. Explain that Twilio labels some fields as "business" fields even for individual submitters.

**Step 3e: Submit verification:**

```
POST https://messaging.twilio.com/v1/Tollfree/Verifications
Content-Type: application/x-www-form-urlencoded
```

With all fields as form-encoded parameters, including `TollfreePhoneNumberSid` (the PN SID from Step 3a).

**Common errors:**
- `"BusinessType must be one of [...]"` — Use exact enum values listed above
- `"Customer profiles submitted with verifications must be either ISV Starters or Secondary Customer Profiles"` — The number is linked to a Primary profile. See Step 3c above.
- `400` or `20001` errors — Check the `message` field for specifics and report to user

**On success:** Tell the user the verification has been submitted and is now `PENDING_REVIEW`. Twilio typically reviews within 1-5 business days. They'll receive status updates at the notification email provided.

**On failure:** Report the exact error message and guide the user through resolution.

## Step 4: Test Send

Run a test SMS to verify end-to-end delivery:

Tell the user: *"Let's send a test SMS to verify everything works. What phone number should I send the test to?"*

**Important:** If toll-free verification is pending (not yet approved), inform the user that test messages may be silently dropped by carriers even though Twilio accepts them. Offer to attempt the test anyway, but set expectations.

**Trial account limitation:** On Twilio trial accounts, SMS can only be sent to verified phone numbers. If the send fails with a "not verified" error, tell the user to verify the recipient number in the Twilio Console under Verified Caller IDs, or upgrade their account.

After the user provides a number, send a test message using the messaging tools:
- Use `messaging_send` with `platform: "sms"`, `conversation_id: "<phone number>"`, and a test message like "Test SMS from your Vellum assistant."
- Report the result honestly:
  - If the send succeeds: *"The message was accepted by Twilio. Note: 'accepted' means Twilio received it for delivery, not that it reached the handset yet. Delivery can take a few seconds to a few minutes. If verification is still pending, carriers may silently drop the message."*
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
- **"Messages not delivering"** — Check compliance status (toll-free verification), verify the number isn't flagged
- **"Twilio error on send"** — Check credentials, phone number assignment, and ingress
- **"Trial account limitations"** — Explain that trial accounts can only send to verified numbers
- **"Customer profiles must be ISV Starters or Secondary"** — The toll-free number is linked to a Primary Customer Profile in Trust Hub. Must be unlinked or reassigned before verification can be submitted.

## Accessing the Twilio API

The skill references IPC messages (`channel_readiness`, `twilio_config`) that are sent via Unix socket to the daemon. The assistant does not have an HTTP endpoint for IPC. Use the following pattern to send IPC messages:

```bash
cd /Users/noaflaherty/Repos/vellum-ai/vellum-assistant/assistant && bun -e '
import { sendOneMessage } from "./src/cli/ipc-client.js";
const res = await sendOneMessage({ type: "twilio_config", action: "get" });
console.log(JSON.stringify(res, null, 2));
'
```

For direct Twilio REST API calls (e.g., toll-free verification submission), use the same `bun -e` pattern with `getSecureKey` from `./src/security/secure-keys.js` to retrieve credentials, then use `fetch()`.
