---
name: launch-playbook
description: Plan and run an end-to-end product, feature, or campaign launch — tiering, channels, timeline, owners, budget, assets, and success metrics. Use for "plan our launch", "we're shipping X", "go-to-market for", or campaign planning.
compatibility: "Designed for Vellum personal assistants — part of the cmo plugin"
metadata:
  emoji: "🚀"
  vellum:
    category: "marketing"
    display-name: "Launch Playbook"
---

Run a launch like a CMO: tier it by impact, plan backward from the date, assign owners, and tie success to the funnel.

## Step graph

### Step 1: Frame the launch
Capture what's launching, the audience, the single primary goal (awareness / pipeline / adoption / expansion), the date, budget, and GTM motion. Push back if the goal is "all of the above" — pick one primary.

### Step 2: Generate the brief
Call **`gtm_launch_plan`** with those facts. It returns the tier, channel matrix, phased timeline checklist, owners to assign, budget split, and funnel-tied success metrics.

### Step 3: Tighten positioning for the launch
If messaging isn't crisp, run the **positioning-sprint** skill (or call `positioning_brief`) so the launch narrative is sharp before assets are produced.

### Step 4: Build the asset list
From the channel matrix, enumerate concrete assets with owners and due dates: launch blog, hero/demo, email(s), social thread, sales one-pager, docs/changelog, in-product announcement. Mark Tier-1 extras (press/analyst pre-briefs, launch event).

### Step 5: Define success up front
Lock the success metrics from the brief into specific targets (e.g. "300 sourced MQLs in 30 days"). Use **`funnel_math`** to translate any pipeline goal into required MQLs.

### Step 6: Run-of-show + retro plan
Produce a launch-day run-of-show (time-ordered, with owners) and schedule a post-launch retro against the metrics. Output a single, scannable launch brief.
