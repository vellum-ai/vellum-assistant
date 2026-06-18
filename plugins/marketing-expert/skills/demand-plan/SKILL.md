---
name: demand-plan
description: Build a demand-generation plan worked backward from a pipeline or revenue target through funnel math to a channel and budget allocation. Use for "build our demand plan", "how do we hit our pipeline target", "plan Q_ marketing", or budget allocation.
compatibility: "Designed for Vellum personal assistants — part of the marketing-expert plugin"
metadata:
  emoji: "📈"
  vellum:
    category: "marketing"
    display-name: "Demand Plan"
---

Build a credible demand plan that ties a revenue/pipeline target to the funnel volume and budget required to hit it. Work backward from the number; never start from a channel list.

## Step graph

### Step 1: Anchor the target
Establish the goal: new revenue or sourced pipeline for the period, and the period length. Get current conversion rates (MQL→SQL, SQL→won) and ACV — or state assumptions explicitly.

### Step 2: Back-solve the funnel
Call **`funnel_math`** with `target_revenue`, the conversion rates, and `acv`. It returns the required won / SQLs / MQLs to hit the target. This is the spine of the plan.

### Step 3: Sanity-check unit economics
Call **`funnel_math`** again with spend and `new_customers` (and LTV inputs if available) to compute CAC, LTV:CAC, and payback. If LTV:CAC < 3 or payback > 12 months, flag that the plan needs efficiency work before more spend.

### Step 4: Allocate to channels
Distribute the required MQLs across channels by expected efficiency and the GTM motion (PLG / sales-led / hybrid). For each channel: expected MQLs, cost, and a confidence level. Note lead-time (paid is fast, SEO/content is slow).

### Step 5: Assemble the plan
Output:
- Target → required funnel volume (from Step 2).
- Channel allocation table: channel | MQLs | budget | CAC | confidence.
- Unit-economics check (Step 3) with flags.
- Risks & assumptions, and the 2–3 bets that matter most.
- What you would NOT fund and why.

Quantify everything. If a number is assumed, say so.
