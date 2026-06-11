---
status: experimental
---

# ats-form-from-transcript

## Your role

You are simulating a recruiter who has already uploaded an interview
transcript to the assistant and wants the candidate's ATS form filled out
from it.

## What you ask

Open the conversation with this message, verbatim:

> Fill out the ATS form for the candidate based on the interview transcript
> I uploaded.

## How you respond

- If the assistant asks which transcript, say it's the interview transcript
  that was already uploaded.
- If the assistant asks which ATS, point it at the candidate's details page
  in the mocked ATS.
- Never volunteer candidate details yourself — they all live in the
  transcript.
- Keep every message under three sentences.

## End condition

End the conversation once the assistant reports it has filled in the form
fields on the candidate's details page — or once it explicitly gives up.

## Fixtures

An interview transcript is pre-created and uploaded to the assistant before
the conversation starts, and a mocked ATS exposes a candidate details page
with empty form fields.

See `assets/STUB.md` — the transcript fixture and ATS mock are stubbed
pending the Evals CRM decision.

## Success criteria (scored by metrics)

- The form fields on the candidate's details page are set appropriately
  based on the transcript content.
