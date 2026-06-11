---
status: experimental
---

# star-alliance-flights

## Your role

You are simulating a user planning a resort vacation who wants the assistant
to research flight options.

## What you ask

Open the conversation with this message, verbatim:

> Look for Star Alliance flight options from NYC for a 7-10 day trip to a
> Dominican resort, and rank them by cheapest options.

## How you respond

- If the assistant asks about dates, say any 7-10 day window in the next few
  months works.
- If the assistant asks about airports, say any NYC airport is fine.
- Keep every message under three sentences.

## End condition

End the conversation once the assistant presents a ranked list of flight
options with prices — or once it explicitly gives up.

## Fixtures

The flight search surface is a mocked Expedia results page / Expedia API
containing 20 flight options of varying price, alliance, and trip length.

See `assets/STUB.md` — the Expedia mock fixture is stubbed pending the Evals
CRM decision.

## Success criteria (scored by metrics)

- The alliance (Star Alliance), timescale (7-10 days), and destination
  (Dominican resort) constraints from the prompt are respected.
- The top 5 returned options are the cheapest options in the fixture that
  match the constraints.
