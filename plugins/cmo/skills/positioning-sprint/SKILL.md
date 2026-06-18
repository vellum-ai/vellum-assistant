---
name: positioning-sprint
description: Run a structured positioning and messaging exercise (April Dunford method) to produce a positioning statement and messaging hierarchy. Use for "position our product", "fix our messaging", "what's our positioning", or competitive repositioning.
compatibility: "Designed for Vellum personal assistants — part of the cmo plugin"
metadata:
  emoji: "🎯"
  vellum:
    category: "marketing"
    display-name: "Positioning Sprint"
---

Run a rigorous positioning exercise and produce a positioning statement plus a messaging hierarchy. Anchor on April Dunford's method: positioning is built from competitive alternatives up, never from a tagline down.

## Step graph

### Step 1: Gather inputs
Ask only for what's missing (don't interrogate — infer from context where you can):
- Product/company and what it does.
- **Competitive alternatives** — what would the customer use if you didn't exist? Include the status quo / "do nothing".
- Unique attributes (capabilities the alternatives lack), the value those enable, the best-fit segment, and any proof points.

### Step 2: Build the canvas
Call the **`positioning_brief`** tool with the gathered facts. It returns a Dunford canvas and a gap checklist.

### Step 3: Close the gaps
For each item in `gaps_to_close`, ask the user or reason it out. Re-run `positioning_brief` if inputs changed materially. Do not proceed while alternatives, attributes, or target segment are empty.

### Step 4: Synthesize
Produce:
1. **Positioning statement** — one sentence: "For [segment] who [need], [product] is a [category] that [key value], unlike [alternatives], because [unique attributes]."
2. **Messaging hierarchy** — umbrella message → 3 pillars → proof point per pillar.
3. **Category frame** — the market category and why it makes your strengths obvious.

### Step 5: Pressure-test
Challenge it: would a skeptical technical buyer believe it? Is the differentiation real or table-stakes? Flag weak claims. Recommend 1–2 next actions (e.g. update homepage hero, sales deck slide 2).

Keep the output board-ready: tight, specific, evidence-backed.
