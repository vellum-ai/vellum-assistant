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

### Step 1: Map the funnel, then anchor the target
First establish **the user's funnel** — don't assume a B2B sales funnel:
- B2B sales-led: lead → MQL → SQL → won, valued by ACV.
- Ecommerce: visit → add-to-cart → purchase (→ repeat), valued by AOV.
- Consumer/subscription: install/signup → activate → subscribe, valued by ARPU/LTV.

Then set the goal: target new revenue (or orders/subscribers) for the period and its length. Get the conversion rate between each stage and the average value per customer/order — or state assumptions explicitly. Use the user's metric names for the rest of the plan.

### Step 2: Back-solve the funnel
Call **`funnel_math`** with `target_revenue`, the stage conversion rates, and the per-customer/order value (map your top-of-funnel metric onto its `mqls`/leads field — the math is stage→stage regardless of labels). It returns the top-of-funnel volume required to hit the target. This is the spine of the plan.

### Step 3: Sanity-check unit economics
Call **`funnel_math`** again with spend and `new_customers` (and LTV inputs if available) to compute CAC, LTV:CAC, and payback. If LTV:CAC < 3 or payback is too long for the business, flag that the plan needs efficiency work before more spend. (Payback tolerance varies — months are fine for high-margin software, much tighter for low-margin ecommerce.)

### Step 4: Allocate to channels
Distribute the required top-of-funnel volume across channels by expected efficiency and the business's motion (e.g. paid search/social, SEO/content, marketplace/retail, lifecycle, partnerships, sales). For each channel: expected volume, cost, and a confidence level. Note lead-time (paid is fast, SEO/content is slow).

### Step 5: Assemble the plan
Output:
- Target → required funnel volume (from Step 2).
- Channel allocation table: channel | volume (leads/sessions/signups) | budget | CAC | confidence.
- Unit-economics check (Step 3) with flags.
- Risks & assumptions, and the 2–3 bets that matter most.
- What you would NOT fund and why.

Quantify everything. If a number is assumed, say so.
