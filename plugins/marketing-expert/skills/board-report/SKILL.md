---
name: board-report
description: Assemble an executive or board marketing update — compute the KPIs, then frame them in a tight narrative with wins, misses, and asks. Use for "board update", "marketing report for the board", "exec marketing summary", or "monthly/QBR marketing review".
compatibility: "Designed for Vellum personal assistants — part of the marketing-expert plugin"
metadata:
  emoji: "📊"
  vellum:
    category: "marketing"
    display-name: "Board Report"
---

Produce a board-ready marketing update: numbers first, narrative tight, asks explicit. The audience is the CEO and board — assume they're smart, busy, and skeptical.

## Step graph

### Step 1: Gather the period's numbers
Collect the metrics **that fit the business** — plus the targets they're measured against, and ask for what's missing (never invent metrics). Spend, new customers, CAC, LTV, and revenue are universal; the funnel/volume metrics depend on the model:
- B2B: MQLs/SQLs, sourced & influenced pipeline, ACV, win rate.
- Ecommerce: sessions, conversion rate, orders, AOV, repeat-purchase rate.
- Consumer/subscription: signups, activation rate, subscribers, ARPU, churn/NRR.

### Step 2: Compute the KPIs
Call **`funnel_math`** to compute CAC (blended & paid), LTV, LTV:CAC, payback, and the funnel projection. Use its flags to judge health. Compare actuals to target and to the prior period.

### Step 3: Structure the report
1. **Headline** — one line: are we on track? The single most important number.
2. **Scorecard** — KPI | target | actual | trend (▲/▼). Use the business's headline metrics (e.g. pipeline & MQLs for B2B; revenue, orders & AOV for ecommerce; subscribers & ARPU for consumer) plus CAC, LTV:CAC, payback.
3. **What worked** — 2–3 wins, each tied to a number.
4. **What didn't** — 1–2 misses, with the diagnosis and the fix.
5. **Asks** — explicit decisions or resources needed from the board.
6. **Next period focus** — the 2–3 priorities.

### Step 4: Tighten
Lead with the answer. Cut adjectives and activity-reporting ("we ran 4 webinars") in favor of outcomes ("webinars drove $X pipeline at $Y CAC"). It should be skimmable in 60 seconds and survive hard questions.

If the user wants a deck, hand off to the pptx skill with this content as the source.
