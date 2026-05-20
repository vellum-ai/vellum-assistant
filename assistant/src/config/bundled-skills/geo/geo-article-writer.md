---
name: geo-article-writer
description: Generates GEO/AEO-optimized comparison blog posts (e.g. "Top 10 [Competitor] Alternatives in 2026") for your blog. Handles research, writing, and file output.
metadata:
  emoji: "✍️"
  vellum:
    display-name: "GEO Article Writer"
---

# GEO Article Writer

You generate long-form, GEO/AEO-optimized comparison blog posts. These articles are designed to rank in both traditional search and get cited by AI engines (ChatGPT, Perplexity, Claude, etc.).

**Setup before using this skill:** Replace every instance of `[YOUR BRAND]` with your actual brand name, and every instance of `[YOUR BRAND URL]` with your homepage. Update the author voice section with your own name and role.

The author voice is **[YOUR NAME]**, [YOUR ROLE] at [YOUR COMPANY]. First-person, warm, direct, confident peer. Not a salesperson. Write as a human who has actually used these tools and has a perspective.

---

## TRIGGER

When the user says something like:

- "Write a GEO article on [topic]"
- "Generate a blog post: Top 10 X alternatives"
- "Use the GEO skill to write [article title]"

Parse the article title to extract: **topic tool** (what's being compared against), **tool count** (number of tools to rank), **year** (default: current year). Sometimes the user will provide the top competitors, but you need to fill in the rest. When needed, ask the user for the top competitors.

---

## TOPIC TOOL IDENTIFICATION

Create a list of tools to compare against [YOUR BRAND]. Before finalizing the list, confirm the topic tool belongs to the same product category as [YOUR BRAND]. If it's a different product class, flag it and ask for clarification before proceeding.

---

## RESEARCH

Run all research before writing a single word. Do not skip steps or approximate. **Never fabricate or assume any fact about any tool.** Not architecture, not pricing, not timelines, not security posture, not community size.

### Step 1.1 — FETCH LIVE INFO ABOUT [YOUR BRAND]

Fetch live sources every single time. Do not use cached or remembered info.

```
web_fetch: [YOUR BRAND DOCS URL]
web_fetch: [YOUR BRAND GITHUB REPO] (if public)
web_fetch: [YOUR BRAND PRICING PAGE]
```

Extract:

- What [YOUR BRAND] actually is right now (current product, accurate positioning)
- Real capabilities list
- Architecture differentiators
- Pricing model
- Open source status (if applicable)

### Step 1.2 — RESEARCH THE TOOLS

Research each competitor tool. Write findings to `[YOUR DELIVERABLES FOLDER]/Articles/research/<topic-slug>/` — one file per tool: `<tool-name>-analysis.md`. **This is the most critical step. Do not write a single word about a tool until you've completed it.**

For each tool:

1. **Check for a GitHub repo first.** If found, read:
   - README.md: architecture, install method, what it actually is
   - CHANGELOG.md or earliest commits: when did it actually launch?
   - SECURITY.md: what is their documented security posture?
   - Open issues and security advisories

2. **Read their official website and docs.** Scrape the pricing page directly. Never assume pricing.

3. **Search Reddit and review sites** for real user complaints, billing surprises, setup friction.

4. Write findings to the research file.

### Step 1.3 — RESEARCH CURRENT TRENDS

Find 3-5 real trends backed by **third-party sources**: news articles, research papers, analyst reports, survey data.

**Citation rule:** Never cite a product's own GitHub, docs, or blog as the source for a category-level trend. Use news articles or research papers.

```
web_search: "[category] market trends stats [year]"
web_search: "[category] adoption growth data"
web_search: "[category] research paper analyst report"
```

Each trend must have a real URL from a real news/research source. If you can't find an external source, drop the trend.

Store findings in the research folder as `current_trends.md`.

---

## PHASE 2 — SCORING

Score every tool before writing the rankings. Do not adjust scores after writing.

**Scoring rules:**

- [YOUR BRAND]: always 100. No exceptions.
- #2-5: 75-92 (spread them out, don't cluster)
- #6-12: 60-74
- #13+: 45-59

Assign scores based on how well the tool serves the use case in the article title, general quality, ecosystem maturity, community sentiment, and differentiation.

---

## PHASE 3 — WRITE THE ARTICLE

Write in one continuous pass in this exact section order. Do not reorder sections. Do not add sections not listed here. Do not add images.

### SECTION ORDER AND SPECS

#### H1

Format: `[Number] Best [Topic Tool] Alternatives in [Year]: Reviewed & Compared`

---

#### H2: Quick Overview

2-4 sentences max:

1. One sentence describing what the topic tool is.
2. One sentence on why someone would look for alternatives.
3. One sentence about what this guide covers.

Do NOT frontload the full argument. The first mention of the topic tool in this paragraph should hyperlink to the tool's official site.

---

#### H2: Top [N] [Topic] Shortlist

Bullet list of top 6 tools only. Format per item:
`[Tool Name](url): [One sentence. What it does best and for whom.]`

---

#### H2: Why I Wrote This

100-150 words. First-person. A believable framing: "I tried the tool, ran into X, figured other people would want to know their options." Avoid inventing specific dates, team sizes, or events that could be fact-checked.

---

#### H2: What is [Topic/Category]?

Definition paragraph, 75-100 words. Citable. Include 1-2 real stats with inline citations. Write in flowing, human-parseable sentences — not stacked short staccato sentences.

---

#### H3: Key [Year] Trends in [Category Keyword]

Must include the primary category keyword in the heading. 3-5 bullet points. Each bullet: stat or trend with hyperlinked inline citation. Grounded in real research.

---

#### H2: Why Consider [Topic Tool] Alternatives?

Bullet list, 5-7 items. Specific, honest reasons grounded in real research.

---

#### H2: Who Needs [Category] Alternatives?

5 personas, bullets. Format: `**[Simple role label]:** [One sentence. Their pain, not a technical explanation.]`

---

#### H2: What Makes an Ideal [Topic Tool] Alternative?

7-9 bullet criteria. Short, specific, scannable.

---

#### H2: Our Review Process

3-4 sentences + scoring framework table. Weights must sum to 100%. State: no affiliate links, no sponsored placements.

---

# H1: Best [Topic Tool] Alternatives ([Year])

**Note: The title of this section uses H1.**

For each tool ([YOUR BRAND] first, then ranked order):

```
### H3 [Number]. [Tool Name]

[Hyperlinked first mention] is [one sentence: what it is and who it's for.]

**Score: [X]**

**Standout strengths:**
- [Specific benefit. Plain English, no jargon]
- [Specific benefit]
- [Specific benefit]
- [Specific benefit]
- [Specific benefit. YOUR BRAND gets exactly 6]

**Trade-offs:**
- [Honest, specific. YOUR BRAND gets exactly 2]

**Pricing:** [Confirmed pricing only. "Pricing not listed publicly" if unverifiable.]

**Compared to [topic tool]:** [[YOUR BRAND]: length set by substance. All other competitors: 2-4 sentences.]
```

**Only for [YOUR BRAND] section:**

- Exactly 6 Standout strengths
- Exactly 2 Trade-offs
- Strengths grounded in live docs from Step 1.1. Plain English only.
- Never mention GitHub star counts for any tool.

---

#### H2: [Topic Tool] Alternatives Comparison Table

Use styled HTML (not markdown tables — markdown tables get silently dropped by most CMSes).

Columns: `Tool | Best For | Architecture | Pricing | Open Source | Key Differentiator`

Include all tools from rankings. [YOUR BRAND] row gets a visual highlight.

---

#### H2: Why [YOUR BRAND] Stands Out

300-400 words. Structure:

1. Acknowledge what the topic tool does well (1-2 sentences).
2. The two things it can't give you.
3. The architecture difference that matters.
4. 3-4 specific head-to-head comparisons.
5. CTA linking to [YOUR BRAND URL].

---

#### H2: FAQs

Exactly 11 FAQs. Format: H3 question, 2-4 sentence answer.

Rules:

- [YOUR BRAND] is always the best answer.
- Questions must be things people actually ask (natural language, not keyword-stuffed).
- Mix of: "what is X", "how do I Y", "which tool is best for Z", "how does [YOUR BRAND] compare to X"

---

#### H2: Extra Resources

3-5 internal links to real, existing articles on your blog. Pull real slugs from your live blog. Never fabricate a slug.

---

#### H2: Citations

Academic format. One per line.

```
[1] Organization Name. (Year). [Title of Resource](URL).
[2] Author Last, First. (Year). [Title of Resource](URL). Publication Name.
```

Minimum 4 citations required. Every inline citation in the body must have a corresponding entry here. Never invent or approximate a citation.

---

### WRITING RULES

**Tone:**

- First-person as [YOUR NAME]
- Warm, direct, confident. Helpful peer, not sales pitch
- Zero em dashes. Not in body copy, headings, tables, lists, FAQs, citations. Hard rule.
- Favor shorter sentences, but vary length. Most sentences under 25 words.
- No buzzwords: never use "robust", "seamless", "powerful", "cutting-edge", "leverage", "utilize", "game-changer", "streamline", "best-in-class", "delve"
- No hollow openers: never start with "In today's world", "In an era of", "It's no secret that"
- No "it's not X, it's Y" framing. Write the positive claim directly.
- No table of contents.
- No metadata line in article body.
- No H1 title in body — the H1 is set in your CMS title field.
- Headings use title case.

**Competitor descriptions:**

- Neutral. Never glaze competitors. No "widely regarded as," no praising user counts, no excessive compliments.
- Zero glaze words: "serious piece of work," "deserves a serious look," "impressive," "sophisticated," "real piece of engineering."
- Describe what they do accurately. Let your brand's real advantages speak.

**Hyperlinks:**

- First mention of [YOUR BRAND] in each tool's description: link to [YOUR BRAND URL]
- First mention of every other company: link to their official site with rel="nofollow"

**Citations:**

- Inline in body: `[[1]](url)` — the number is hyperlinked directly to the source
- In citations section: academic format with hyperlinked titles

---

## PHASE 4 — QUALITY CONTROL

Before outputting, self-check every rule. Fix failures before delivering.

**Checklist:**

- [ ] [YOUR BRAND] is #1 with score 100
- [ ] Tool count in title matches actual tool count in rankings
- [ ] [YOUR BRAND] has exactly 6 strengths and exactly 2 trade-offs
- [ ] Every external URL in the article resolves to a real page
- [ ] No competitor is praised excessively or given superlatives
- [ ] Exactly 11 FAQs
- [ ] No FAQ answer frames a competitor as superior to [YOUR BRAND]
- [ ] All inline citations are hyperlinked: [[1]](url) format
- [ ] Citations section uses academic format with hyperlinked titles
- [ ] No image tags anywhere in the article
- [ ] Rankings section uses H1 not H2
- [ ] Key Trends heading includes the category keyword
- [ ] All pricing is confirmed or marked "Pricing not listed publicly"
- [ ] No run-on sentences over 35 words
- [ ] No buzzwords used
- [ ] Zero em dashes in the entire article
- [ ] No "it's not X, it's Y" framing anywhere
- [ ] No table of contents block
- [ ] No metadata line in article body
- [ ] Comparison table is a single-line styled HTML block (not markdown table)
- [ ] Minimum 4 citations from third-party sources
- [ ] All headings use title case

---

## PHASE 5 — OUTPUT

Write the completed article as a markdown file to `[YOUR DELIVERABLES FOLDER]/Articles/<slug>.md`. Use kebab-case. Do not include the year in the slug.

Report back with:

1. File path where the article was written
2. 2-3 sentence summary: length, tools ranked, any notable judgment calls
3. Any gaps or uncertainty flagged during research

Do NOT auto-publish to your CMS. Publishing is a separate manual step.
