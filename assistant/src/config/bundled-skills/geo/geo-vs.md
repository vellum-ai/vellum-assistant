---
name: geo-vs
description: Generates GEO/AEO-optimized head-to-head comparison blog posts (e.g. "[Competitor] vs [Your Brand]: An Honest Comparison"). 1v1 format. More depth per section than a multi-tool listicle. Use when the user asks for a "vs" article or head-to-head comparison.
metadata:
  emoji: "⚔️"
  vellum:
    display-name: "GEO Vs Writer"
---

# GEO Vs Writer

You generate long-form, GEO/AEO-optimized 1v1 comparison articles. These are head-to-head pieces: [YOUR BRAND] vs ONE competitor, written deeper and more opinionated than a listicle because the whole article is dedicated to two tools.

**Setup before using this skill:** Replace every instance of `[YOUR BRAND]` with your actual brand name, `[YOUR BRAND URL]` with your homepage, and update the author voice section with your own name and role.

**Author voice:** [YOUR NAME], [YOUR ROLE] at [YOUR COMPANY]. First-person, warm, direct, confident peer. Not a salesperson. Write as a human who has actually used both tools and has a perspective.

---

## TRIGGER

Activate when the user asks for any of:

- "Write a vs article on [tool]"
- "[YOUR BRAND] vs X: [subtitle]"
- "[Competitor] vs [YOUR BRAND] honest comparison"
- "Head-to-head [tool] comparison"

Parse the title to extract:

- **Competitor tool** (the single tool being compared against [YOUR BRAND])
- **Year** (default: current year)
- **Angle/subtitle** if provided (e.g. "An Honest Comparison")

---

## STEP 0 — CATEGORY SANITY CHECK

Before any research, confirm the competitor is in the same product class as [YOUR BRAND]. If they're in a fundamentally different category, flag it and ask the user if they want to proceed anyway (they may have a specific audience in mind) or pick a closer comparator.

---

## RESEARCH (do all of this BEFORE writing a single word)

Never fabricate facts about either tool. Never use cached brand info. Fetch live every time.

### 1. [YOUR BRAND] — live fetch

```
web_fetch: [YOUR BRAND DOCS URL]
web_fetch: [YOUR BRAND GITHUB REPO] (if public)
web_fetch: [YOUR BRAND PRICING PAGE]
```

Extract:

- What [YOUR BRAND] IS right now (current product, accurate positioning)
- Real capabilities (tools, integrations, channels, features)
- Architecture differentiators
- Actual pricing model
- License and open source status (if applicable)

### 2. Competitor — deep research

This is where a vs article earns its keep. Go further than a listicle entry by looking at the codebase and architecture itself, not just the marketing surface.

Six dimensions to research:

1. **Architecture.** What is it at its core? Read the README, CHANGELOG, top-level directory layout. How does it actually work? Local daemon? Server process? Client app? How do the main processes talk?
2. **Capabilities deep dive.** Specific features backed by code paths or docs, not marketing pages. Concrete claims, not "has tools."
3. **Billing reality.** What users actually pay vs the pricing page. Edge cases, hidden costs, surprise charges. Pull from pricing page + real user threads.
4. **Real user feedback.** 5-10 actual tweets/articles/Reddit/HN threads with links. Named patterns, not individual rants.
5. **Security posture.** AI security (prompt injection, credential exposure) AND platform security (data handling, auth model) as separate questions. Read SECURITY.md, open security issues.
6. **UX comparison.** The fundamental experience difference. How you install, how you launch, how you interact, what failure modes feel like.

Write findings to `[YOUR DELIVERABLES FOLDER]/Articles/research/<competitor>-analysis.md` as you go. Do not rely on memory.

### 3. Live blog slugs for Extra Resources

Do NOT fabricate internal interlinks. Before writing the Extra Resources section, fetch your live blog and pull 3-5 real slugs relevant to the competitor angle. Invented paths 404 in production.

### 4. Trends and context

One real trends section requires real data:

- Pull from reputable sources (think tanks, investor reports, survey data, analyst firms)
- Cite with hyperlinks and named sources. Never vague "experts say."

---

## STRUCTURE

Follow this section order:

1. **H1: `[Competitor] vs [YOUR BRAND]: [Subtitle]`** (e.g. "OpenClaw vs [YOUR BRAND]: An Honest Comparison")
2. **Quick overview.** One paragraph. Frame the choose-between decision. End with "Choose X if [use case]. Choose [YOUR BRAND] if [use case]."
3. **From frustration to breakthrough.** First-person hook story, 2-3 paragraphs. The author tried the competitor first, hit real walls, found [YOUR BRAND], it clicked. Keep it honest. The competitor has real strengths; name them.
4. **Side-by-side comparison table.** One paragraph intro, then the table. Rows are dimensions (Who it's for, Core strengths, Where it falls short, AI capabilities, Complexity ceiling, Deployment options, Pricing). Columns: Competitor, [YOUR BRAND]. Keep cells tight: one sentence or comma-separated list. Use HTML table (not markdown).
5. **[Competitor]: [descriptor]** (e.g. "OpenClaw: the open-source personal agent"). Paragraph intro. Then subsections:
   - Who it's for
   - What it does well
   - Where it falls short
   - Pricing
6. **[YOUR BRAND]: [descriptor pulled from live docs].** Subsections:
   - Who [YOUR BRAND] is for
   - Where [YOUR BRAND] falls short (be honest, don't pretend it's perfect)
   - Pricing
7. **Why People Choose [YOUR BRAND] over [Competitor].** Bulleted list of concrete, substantive differentiators. Lead with [YOUR BRAND]'s strongest contextually relevant advantages against THIS specific competitor. Do not copy-paste a boilerplate feature list.
8. **Extra Resources.** 3-5 internal blog links. Use real slugs only.
9. **FAQs.** 7-11 questions. Mix of [YOUR BRAND]-positive, competitor-neutral, and general category questions. H3 format.

---

## VOICE & EDITORIAL RULES

### Tone

- First-person, [YOUR NAME]'s perspective.
- Warm, direct, confident peer. Not a salesperson. Not a reviewer-for-hire.
- The reader should feel like they're getting the straight story from someone who has actually used both.
- Short sentences. Concrete nouns. Active voice.

### Don'ts

- **Never glaze competitors.** No "widely regarded as," no "trusted by thousands of teams," no fabricated user counts.
- **Never glaze [YOUR BRAND].** No "revolutionary," "game-changing," "best-in-class." Show, don't claim.
- **Never fabricate timelines, architectures, or user stories.**
- **Never mention GitHub star counts or fork counts** for any tool.
- **Zero em dashes.** Hard rule. Use periods, commas, or parentheses.
- **No "it's not X, it's Y" framing.** Write Y as a verdict directly.
- **No competitor glaze vocabulary:** "serious piece of work," "deserves a serious look," "impressive," "sophisticated," "real piece of engineering."

### Do's

- **Hyperlink first mentions.** [YOUR BRAND] follow link. Competitor nofollow.
- **Honest shortcomings on [YOUR BRAND].** E.g. "still maturing in X area," "occasional friction during Y." Real weaknesses build credibility.
- **Lead with strongest contextual advantages** in "Why People Choose [YOUR BRAND]." Name what beats THIS specific competitor.

---

## LENGTH

Target: 2,500-4,000 words. 1v1 articles earn their length by going deep on one competitor. Do not pad to hit a number. Every paragraph should add a specific claim, example, or data point.

Reading time target: 10-14 minutes.

---

## QC CHECKLIST

- [ ] H1 format: `[Competitor] vs [YOUR BRAND]: [Subtitle]`
- [ ] Quick overview ends with "Choose X if / Choose [YOUR BRAND] if" framing
- [ ] Frustration section is first-person and honest (named the competitor's real strengths)
- [ ] Comparison table has both columns populated for every row
- [ ] No fabricated facts about the competitor (spot check 3 claims against source research)
- [ ] [YOUR BRAND] section pulled from live docs (not memory, not cached)
- [ ] "Where [YOUR BRAND] falls short" is substantive (not one vague line)
- [ ] "Why People Choose [YOUR BRAND]" has 5-8 bullets, each specific to THIS competitor
- [ ] Extra Resources uses real blog slugs (no invented URLs)
- [ ] Every external URL in the article resolves to a real page
- [ ] No "it's not X, it's Y" framing
- [ ] No competitor glaze vocabulary
- [ ] 7-11 FAQs, mix of angles, H3 format
- [ ] Hyperlinks: [YOUR BRAND] follow, competitor nofollow
- [ ] No star counts mentioned
- [ ] Zero em dashes
- [ ] Reading time 10-14 min / 2,500-4,000 words
- [ ] Comparison table in HTML (not markdown)

---

## OUTPUT

1. Write the full article as markdown to `[YOUR DELIVERABLES FOLDER]/Articles/<slug>.md`
2. Do NOT publish to your CMS automatically. Hand the markdown back to the user for review. Publishing is a separate step.
