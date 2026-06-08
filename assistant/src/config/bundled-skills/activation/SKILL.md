---
name: activation
description: Record activation funnel milestones for the activation rail
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🚀"
  vellum:
    display-name: "Activation"
---

Records activation-funnel milestone events for the activation rail. The single
tool, `emit_activation_event`, takes a `step_name` and persists a funnel
milestone so we can measure how far new users get on their first run.

This tool is always available but does nothing outside the activation rail: it
is gated at runtime. `emitActivationMoment` returns `not_activation_session` for
any conversation that was not started on the activation rail, so a stray call in
a normal chat never pollutes the funnel. Only the activation-rail bootstrap
instructs the model to call it.

## Firing the milestones

Emit each milestone from the scoped tool call that does the rail work — not on
every text turn. See `BOOTSTRAP-ACTIVATION-RAIL.md` for the exact firing
conditions bound to the rail's moves.

## Boundaries

- The tool never errors a turn. An expected rejection (unknown step, wrong
  session) returns a terse non-error result.
