---
name: influencer
description: Research influencers on Instagram, TikTok, and X/Twitter through your browser
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔍"
  vellum:
    display-name: "Influencer Research"
    includes: ["browser"]
---

Use browser automation for collection and `host_bash` helper scripts for deterministic parsing, scoring, and comparison. All browser operations are executed through the `assistant browser` CLI, invoked via `host_bash`.

## Required tools

- `host_bash` for `assistant browser` CLI commands and helper scripts in `scripts/`.

## Hard constraints

- Do not call `assistant browser chrome relay`.
- Do not use legacy relay-backed influencer scripts.

## Step graph (state machine)

### Step 1: Route intent

Use deterministic routing when intent is unclear:

```bash
bun {baseDir}/scripts/influencer-intent.ts --request "<latest user request>" --has-candidates <true|false> --has-shortlist <true|false>
```

Use returned `step` to route to `discover`, `enrich_profile`, or `compare_shortlist`.

### Step 2: Discover candidates (`discover`)

#### Instagram

1. Navigate to keyword search/post surfaces.
2. Snapshot + extract:

```bash
assistant browser --session influencer --json snapshot
assistant browser --session influencer --json extract --include-links
```

3. Parse candidates:

```bash
bun {baseDir}/scripts/influencer-parse-candidates.ts --platform instagram --input-json '<json payload with extracted text/links>'
```

#### TikTok

1. Navigate to user search page for query.
2. Use `assistant browser --session influencer scroll` + `assistant browser --session influencer wait-for` to load additional candidates.
3. Extract and parse:

```bash
bun {baseDir}/scripts/influencer-parse-candidates.ts --platform tiktok --input-json '<json payload with extracted text>'
```

#### X/Twitter

1. Navigate to people search view (`f=user`).
2. Snapshot + extract:

```bash
assistant browser --session influencer --json snapshot
assistant browser --session influencer --json extract --include-links
```

3. Parse:

```bash
bun {baseDir}/scripts/influencer-parse-candidates.ts --platform twitter --input-json '<json payload with extracted text/links>'
```

### Step 3: Enrich profiles (`enrich_profile`)

For each selected candidate profile:

1. Navigate to profile URL.
2. Snapshot + extract profile metadata (bio, follower counts, verification indicators).
3. Score with criteria:

```bash
bun {baseDir}/scripts/influencer-score.ts --query "<user query>" --min-followers <n> --max-followers <n> --verified-only <true|false> --input-json '<json payload with profiles>'
```

4. If themes are missing, enrich using:

```bash
bun {baseDir}/scripts/influencer-theme-extract.ts --bio "<bio>" --query "<user query>"
```

### Step 4: Build shortlist (`compare_shortlist`)

Generate deterministic comparison output:

```bash
bun {baseDir}/scripts/influencer-compare.ts --limit <n> --input-json '<json payload with profiles and criteria>'
```

Present results grouped by platform with:

- Username / display name
- Followers (normalized)
- Verification status
- Theme highlights
- Profile URL

## Retry and fallback policy

- Retry budget: 3 attempts for each state-changing browser step.
- After any navigation or click that changes DOM, run fresh `assistant browser --session influencer --json snapshot`.
- If blocked by sign-in wall or challenge after retries, ask user to complete that step and resume from latest successful state.

## Platform notes

- Instagram search often surfaces posts/reels before profiles; use author-handle pivot logic.
- TikTok search can require scroll cycles to load profile cards.
- X/Twitter should use people-search surfaces to avoid irrelevant mixed-content feeds.

## Example helper payload shape

```json
{
  "phase": "discover",
  "context": { "platform": "instagram" },
  "extracted": {
    "text": "...",
    "links": ["https://www.instagram.com/example/"]
  },
  "userIntent": "find fitness creators"
}
```
