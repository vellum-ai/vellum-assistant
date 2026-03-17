---
name: influencer
description: Research influencers on Instagram, TikTok, and X/Twitter using the Chrome extension relay
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔍"
  vellum:
    display-name: "Influencer Research"
---

You can research and discover influencers across Instagram, TikTok, and X/Twitter using the bundled influencer scripts.

## Script Setup

**IMPORTANT: Always use `host_bash` (not `bash`) for all influencer commands.** The scripts need host access for the `assistant` CLI binary (used for the Chrome extension relay), which is not available inside the sandbox.

The influencer scripts are bundled with this skill. Run them via `bun run {baseDir}/scripts/influencer.ts <subcommand> [options]`.

## Prerequisites

- The Chrome extension relay must be connected (user should have the Vellum extension loaded in Chrome)
- The user must be **logged in** on each platform they want to search (Instagram, TikTok, X) in their Chrome browser
- The extension MUST have the `debugger` permission (required to bypass CSP on Instagram and other Meta sites)
- If the relay is not connected, tell the user: "Please open Chrome, click the Vellum extension icon, and click Connect - then I'll retry."

## Platform-Specific Architecture

### Instagram
Instagram's search at `/explore/search/keyword/?q=...` shows a **grid of posts**, NOT profiles. The discovery flow is:
1. Search by keyword → extract post links (`/p/` and `/reel/`)
2. Visit each post → find the author username from page links
3. Deduplicate usernames
4. Visit each unique profile → scrape stats from `meta[name="description"]` (most reliable source, format: "49K Followers, 463 Following, 551 Posts - Display Name (@user)")
5. Filter and rank by criteria

**CSP Note:** Instagram blocks `eval()`, `new Function()`, inline scripts, and blob URLs via strict CSP. The extension uses `chrome.debugger` API (CDP Runtime.evaluate) as a fallback, which bypasses all CSP restrictions.

### TikTok
TikTok has a dedicated user search at `/search/user?q=...`. Each result card produces a predictable text pattern in `innerText`:
```
DisplayName
username
77.9K
Followers
·
1.5M
Likes
Follow
```
We parse this pattern directly (DOM class selectors are obfuscated and unreliable on TikTok). After extracting usernames and follower counts, we visit each profile for bios.

### X/Twitter
X has a people search at `/search?q=...&f=user` with `[data-testid="UserCell"]` components containing username, display name, bio, and verified status.

## Typical Flow

When the user asks to find or research influencers:

1. **Understand the criteria.** Ask about:
   - **Niche/topic** - what kind of influencers? (fitness, beauty, tech, food, etc.)
   - **Platforms** - Instagram, TikTok, X/Twitter, or all three?
   - **Follower range** - micro (1K-10K), mid-tier (10K-100K), macro (100K-1M), mega (1M+)?
   - **Verified only?** - do they need the blue checkmark?
   - Don't over-ask. If the user says "find me fitness influencers on Instagram", that's enough to start.

2. **Search** - run `bun run {baseDir}/scripts/influencer.ts search "<query>" --platforms <platforms> [options] --json`

3. **Present results** - show a clean summary of each influencer found:
   - Username and display name
   - Platform
   - Follower count
   - Bio snippet
   - Verified status
   - Content themes detected
   - Profile URL

4. **Deep dive** (if needed) - run `bun run {baseDir}/scripts/influencer.ts profile <username> --platform <platform> --json` to get detailed data on a specific influencer.

5. **Compare** (if needed) - run `bun run {baseDir}/scripts/influencer.ts compare instagram:user1 twitter:user2 tiktok:user3 --json` to compare influencers side by side.

## Follower Range Shortcuts

When the user describes influencer tiers, map to these ranges:
- **Nano**: `--min-followers 1000 --max-followers 10000`
- **Micro**: `--min-followers 10000 --max-followers 100000`
- **Mid-tier**: `--min-followers 100000 --max-followers 500000`
- **Macro**: `--min-followers 500000 --max-followers 1000000`
- **Mega**: `--min-followers 1000000`

Human-friendly numbers are supported: `10k`, `100k`, `1m`, etc.

## Command Reference

```
bun run {baseDir}/scripts/influencer.ts search "<query>" [options] --json
  --platforms <list>       Comma-separated: instagram,tiktok,twitter (default: all three)
  --min-followers <n>      Minimum follower count (e.g. 10k, 100000)
  --max-followers <n>      Maximum follower count (e.g. 1m, 500k)
  --limit <n>              Max results per platform (default: 10)
  --verified               Only return verified accounts

bun run {baseDir}/scripts/influencer.ts profile <username> --platform <platform> --json
  --platform <platform>    instagram, tiktok, or twitter (default: instagram)

bun run {baseDir}/scripts/influencer.ts compare <platform:username ...> --json
  Arguments are space-separated platform:username pairs
  e.g. instagram:nike twitter:nike tiktok:nike
```

## Important Behavior

- **Use `--json` flag** on all commands for reliable parsing.
- **Always use `host_bash`** for these commands, never `bash`.
- **Be patient with results.** The tool navigates actual browser tabs, so each platform search takes 10-30 seconds. Warn the user it may take a moment.
- **Rate limiting.** Don't hammer the platforms. The tool has built-in delays, but avoid running many searches in rapid succession.
- **Present results nicely.** Use tables or formatted lists. Group by platform. Highlight standout profiles.
- **Offer next steps.** After showing results, ask if they want to:
  - Get more details on specific profiles
  - Compare top picks side by side
  - Search with different criteria
  - Export the results
- **Handle errors gracefully.** If a platform fails (e.g. not logged in), show results from the platforms that worked and mention which one failed.
- **Do NOT use the browser skill.** All influencer research goes through the bundled scripts, not browser automation. Do NOT use `assistant influencer` directly - use the bundled scripts.

## Example Interactions

**User**: "Find me fitness influencers on Instagram and TikTok"

1. `bun run {baseDir}/scripts/influencer.ts search "fitness coach workout" --platforms instagram,tiktok --limit 10 --json`
2. Present results grouped by platform with follower counts and bios
3. "I found 8 fitness influencers on Instagram and 6 on TikTok. Want me to dig deeper into any of these profiles?"

**User**: "I need micro-influencers in the beauty niche, verified only"

1. `bun run {baseDir}/scripts/influencer.ts search "beauty makeup skincare" --platforms instagram,tiktok,twitter --min-followers 10k --max-followers 100k --verified --limit 10 --json`
2. Present filtered results
3. Offer to compare top picks

**User**: "Compare @username1 on Instagram with @username2 on TikTok"

1. `bun run {baseDir}/scripts/influencer.ts compare instagram:username1 tiktok:username2 --json`
2. Present side-by-side comparison with followers, engagement, bio, themes

**User**: "Tell me more about @specificuser on Instagram"

1. `bun run {baseDir}/scripts/influencer.ts profile specificuser --platform instagram --json`
2. Show full profile details including bio, follower/following counts, verified status, content themes
