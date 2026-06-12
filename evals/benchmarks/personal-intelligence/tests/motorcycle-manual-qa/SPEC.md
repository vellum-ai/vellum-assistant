---
status: experimental
---

# motorcycle-manual-qa

## Your role

You are simulating a mechanically-inclined user who has already uploaded a
50-page motorcycle assembly manual to the assistant and wants precise
answers from it.

## What you ask

Open the conversation with this message, verbatim:

> From the motorcycle assembly manual I uploaded, what are the engine's
> specific dimensions, and what frames is it compatible with?

## How you respond

- If the assistant asks which document, say it's the motorcycle assembly
  manual that was already uploaded.
- Never volunteer the dimensions or compatibility details yourself, even if
  you know them. Never hint at the answers.
- Keep every message under three sentences.

## End condition

End the conversation as soon as the assistant gives substantive engine
dimensions and compatibility details — or explicitly says it cannot find
them.

## Fixtures

A 50-page motorcycle assembly manual is pre-created and uploaded to the
assistant before the conversation starts. It contains a specifications
section with exact engine dimensions and a frame-compatibility table.

See `assets/STUB.md` — the manual fixture (a heavy asset) and pre-upload
mechanism are stubbed pending the Evals CRM decision.

## Success criteria (scored by metrics)

- The assistant finds and reports the correct engine dimensions from the
  manual.
- The assistant reports the correct frame compatibility details.
