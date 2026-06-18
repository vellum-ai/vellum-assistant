# marketing-expert

Lets your Vellum assistant act as a full-stack **Marketing Expert** for any
business (B2B or B2C — SaaS, ecommerce, marketplace, consumer, services, and more)
— but only when the user actually needs marketing help. The Marketing Expert depth is
**activated on demand** by skills, not bolted onto every turn. One self-contained
plugin, three layers:

| Layer | What it is | What it's for |
| --- | --- | --- |
| **Hook** (`hooks/pre-model-call.ts`) | A single-line activation pointer appended to the system prompt | Awareness — so the model knows to engage Marketing Expert mode when marketing comes up |
| **Skills** (`skills/`) | On-demand step-graph playbooks bundled in the plugin; **trigger on marketing requests** | The Marketing Expert mindset + rigorous, repeatable workflows |
| **Tools** (`tools/`) | Deterministic helpers the model calls inline | Math & structured scaffolds it shouldn't improvise |

**Activation model:** nobody opens the assistant looking for a "Marketing Expert". So the
system-prompt footprint is one line (`src/marketing-expert-frame.ts`); the real persona,
operating principles, and competency depth live in the on-demand `marketing-expert` skill,
which fires when the user asks for marketing help and routes to the specific
playbooks.

## Tools

- **`funnel_math`** — CAC (blended & paid), LTV, LTV:CAC, payback months, and
  MQL→SQL→won→pipeline→revenue projections, with health flags. Real arithmetic.
- **`positioning_brief`** — April Dunford positioning canvas + gap checklist.
- **`gtm_launch_plan`** — tiered launch/campaign brief: channels, timeline,
  owners, budget split, funnel-tied success metrics.
- **`competitive_scan`** — competitor investigation rubric + comparison format
  (the model fills it with its web tools; we don't reimplement search).

## Skills (bundled, plugin-owned)

- **`marketing-expert`** — the general entry point: the Marketing Expert persona + operating principles, and
  a router to the specific playbooks. Triggers on broad marketing requests
  ("help with marketing", "be my Marketing Expert", "marketing strategy").
- **`founder-marketing`** — zero-to-one, founder-led growth for founders with
  little time/team/budget (the early-stage counterpart to `demand-plan`).
- **`positioning-sprint`**, **`demand-plan`**, **`launch-playbook`**,
  **`content-engine`**, **`geo-audit`** (one-command technical GEO audit of a site),
  **`geo-writing`** (GEO/AEO articles built to get cited by AI engines),
  **`competitive-teardown`**, **`board-report`** — specific workflows; each pairs
  with the relevant tool so the skill stays a procedure and the tool does the
  deterministic part.

They install, version, and uninstall with this plugin.

## Install / verify

1. The plugin lives at `<workspaceDir>/plugins/marketing-expert/`. Restart the assistant so the
   plugin loader picks up the hook + tools and the skill catalog discovers the
   bundled skills.
2. Confirm load in the daemon logs (no `marketing-expert` load error).
3. Ask for marketing help (e.g. "how are we doing on CAC?" with some numbers, or
   "plan our Q3 launch") and confirm the right `marketing-expert` skill activates, the reply
   reads like a Marketing Expert, and `funnel_math` is called for any math.

## Notes

- The hook self-gates on `callSite === "mainAgent"`, so the one-line pointer never
  leaks into background/subagent/compaction calls — and it's just one line, so it
  costs almost nothing on turns that have nothing to do with marketing.
- Built against `@vellumai/plugin-api` (beta; pin the peer-dep range).
