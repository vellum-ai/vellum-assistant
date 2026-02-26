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

When the remote check returns `toll_free_verification` as a failing check, use the daemon's built-in IPC compliance actions. These handle credential lookup, phone number SID resolution, field validation, and Twilio API calls internally.

**Step 3a: Check compliance status.** First check if a verification already exists:

```json
{
  "type": "twilio_config",
  "action": "sms_compliance_status"
}
```

The response includes a `compliance` object with `numberType`, `tollfreePhoneNumberSid`, `verificationSid`, `verificationStatus`, `rejectionReason`, `rejectionReasons`, `editAllowed`, and `editExpiration` fields. For toll-free numbers, `tollfreePhoneNumberSid` contains the Twilio phone number SID needed for verification submission.

- If `verificationStatus` is `PENDING_REVIEW` or `IN_REVIEW`, tell the user verification is already in progress and skip submission.
- If `verificationStatus` is `TWILIO_APPROVED`, compliance is complete — proceed to Step 4.
- If `verificationStatus` is `TWILIO_REJECTED` and `editAllowed` is true, offer to update the existing verification (Step 3d) instead of resubmitting.
- If no verification exists (`verificationSid` is absent), proceed to collect information and submit.

**Step 3b: Collect user information.** Collect the following from the user (assume individual/sole proprietor by default):

| Field | `verificationParams` key | Notes |
|---|---|---|
| Name | `businessName` | Can be personal name |
| Business type | `businessType` | Use `SOLE_PROPRIETOR` for individuals. Valid values: `PRIVATE_PROFIT`, `PUBLIC_PROFIT`, `SOLE_PROPRIETOR`, `NON_PROFIT`, `GOVERNMENT` |
| Website | `businessWebsite` | LinkedIn or personal site is fine |
| Notification email | `notificationEmail` | Where Twilio sends status updates |
| Use case category | `useCaseCategories` | Array, e.g. `["ACCOUNT_NOTIFICATIONS"]` |
| Use case summary | `useCaseSummary` | Plain English description |
| Message volume | `messageVolume` | Must be one of: `10`, `100`, `1,000`, `10,000`, `100,000`, `250,000`, `500,000`, `750,000`, `1,000,000`, `5,000,000`, `10,000,000+` |
| Sample message | `productionMessageSample` | A realistic example message |
| Opt-in type | `optInType` | `VERBAL`, `WEB_FORM`, `PAPER_FORM`, `VIA_TEXT`, `MOBILE_QR_CODE` |
| Opt-in image URL | `optInImageUrls` | Array of URLs showing opt-in mechanism (can be website URL) |

The `tollfreePhoneNumberSid` is returned by the `sms_compliance_status` response in the `compliance` object. Use `compliance.tollfreePhoneNumberSid` from the Step 3a response as the value for `verificationParams.tollfreePhoneNumberSid` when submitting. Do NOT ask for EIN, business registration number, or business registration authority. Explain that Twilio labels some fields as "business" fields even for individual submitters.

**Step 3c: Submit verification:**

```json
{
  "type": "twilio_config",
  "action": "sms_submit_tollfree_verification",
  "verificationParams": {
    "tollfreePhoneNumberSid": "<compliance.tollfreePhoneNumberSid from Step 3a>",
    "businessName": "...",
    "businessWebsite": "...",
    "notificationEmail": "...",
    "useCaseCategories": ["ACCOUNT_NOTIFICATIONS"],
    "useCaseSummary": "...",
    "productionMessageSample": "...",
    "optInImageUrls": ["..."],
    "optInType": "VERBAL",
    "messageVolume": "100",
    "businessType": "SOLE_PROPRIETOR"
  }
}
```

The daemon validates all fields before submitting to Twilio and returns clear error messages for invalid values.

**On success:** The response contains `compliance.verificationSid` and `compliance.verificationStatus` (typically `PENDING_REVIEW`). Tell the user Twilio typically reviews within 1-5 business days.

**On failure:** Report the exact error from the response and guide the user through resolution.

**Step 3d: Update a rejected verification** (if `editAllowed` is true):

```json
{
  "type": "twilio_config",
  "action": "sms_update_tollfree_verification",
  "verificationSid": "<sid from compliance status>",
  "verificationParams": {
    "businessName": "updated value",
    "useCaseSummary": "updated value"
  }
}
```

Only include fields that need to change. The daemon checks edit eligibility and expiration before attempting the update.

**Step 3e: Delete and resubmit** (if editing is not allowed):

```json
{
  "type": "twilio_config",
  "action": "sms_delete_tollfree_verification",
  "verificationSid": "<sid from compliance status>"
}
```

After deletion, return to Step 3b to collect information and resubmit. Warn the user that deleting resets their position in the review queue.

**Common errors:**
- `"Customer profiles submitted with verifications must be either ISV Starters or Secondary Customer Profiles"` — The number is linked to a Primary Customer Profile in Trust Hub, which blocks toll-free verification. Tell the user and suggest they resolve the profile assignment in the Twilio Console.
- Missing required fields — The daemon validates and reports which fields are missing.
- Invalid enum values — The daemon validates `optInType`, `messageVolume`, and `useCaseCategories` and reports valid values.

**On success:** Tell the user the verification has been submitted and is now `PENDING_REVIEW`. Twilio typically reviews within 1-5 business days. They'll receive status updates at the notification email provided.

**On failure:** Report the exact error message and guide the user through resolution.

## Step 3.5: Guardian Verification (SMS)

Now link the user's phone number as the trusted SMS guardian. Tell the user: "Now let's verify your guardian identity for SMS. This links your phone number as the trusted guardian for SMS messaging."

Install and load the **guardian-verify-setup** skill to handle the verification flow:

- Call `vellum_skills_catalog` with `action: "install"` and `skill_id: "guardian-verify-setup"`.
- Then call `skill_load` with `skill: "guardian-verify-setup"`.

When invoking the skill, indicate the channel is `sms`. The guardian-verify-setup skill manages the full outbound verification flow, including:
- Collecting the user's phone number as the destination (accepts any common format -- the API normalizes to E.164)
- Starting the outbound verification session via `POST /v1/integrations/guardian/outbound/start` with `channel: "sms"`
- Sending a 6-digit code to the phone number that the user must reply with from the SMS channel
- Checking guardian status to confirm the binding was created
- Handling resend, cancel, and error cases

Tell the user: *"I've loaded the guardian verification guide. It will walk you through linking your phone number as the trusted SMS guardian."*

**Note:** Guardian verification is optional but recommended. If the user declines or wants to skip, proceed to Step 4 without blocking.

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
cd "$(git rev-parse --show-toplevel)/assistant" && bun -e '
import { sendOneMessage } from "./src/cli/ipc-client.js";
const res = await sendOneMessage({ type: "twilio_config", action: "get" });
console.log(JSON.stringify(res, null, 2));
'
```

All compliance operations (status checks, verification submission, updates, and deletion) are handled through the `twilio_config` IPC actions — no direct Twilio REST calls are needed.
