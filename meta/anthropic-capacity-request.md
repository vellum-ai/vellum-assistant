# Anthropic Capacity Request: Recommended Values

## Context

This analysis derives recommended values for the Anthropic capacity assurance form based on the Vellum Assistant architecture. The product is a managed AI assistant platform where each user has a personal assistant backed by Anthropic models. The architecture uses **three distinct model tiers** via `modelIntent`, each with different call patterns.

---

## Architecture-Driven Call Breakdown

### What happens per user message

Each user message triggers an **agentic loop** of 3-5 LLM calls plus background work:

| Call Type | Model (Anthropic) | Frequency per user msg | Avg Input Tokens | Avg Output Tokens |
|---|---|---|---|---|
| Main conversation loop (tool use) | Opus (quality-optimized) | 3-4 calls | 12,000-20,000 | 150-300 (tool calls), 500-1,500 (final) |
| Memory extraction | Haiku (latency-optimized) | 1 call | 500-1,000 | 200-400 |
| Title generation | Haiku (latency-optimized) | 0.1 calls (first turn only) | 300-500 | 10-20 |
| Summarization | Haiku (latency-optimized) | 0.2 calls (periodic) | 2,000-4,000 | 400-600 |
| Notification routing | Haiku (latency-optimized) | 0.3 calls (event-driven) | 1,000-1,500 | 200-300 |
| Vision/screenshots | Sonnet (vision-optimized) | 0-1 calls (when images) | 15,000-25,000 | 500-1,500 |

**Total: ~5 LLM API calls per user message** (3.5 Opus + 1.5 Haiku on average)

### Prompt caching: 3 breakpoints (all ephemeral, 5-min TTL)

From `assistant/src/providers/anthropic/client.ts`:
1. **System prompt** (~6,000-8,000 tokens) — cached as single text block
2. **Last tool definition** (~1,000-3,000 tokens) — entire tool array up to last tool
3. **Last 2 user message turns** — conversation prefix cached across agentic loop iterations

### Cache behavior within an agentic loop (4 calls)

| Call | Cache Read | Cache Write | Regular (uncached) |
|---|---|---|---|
| 1st (fresh prefix) | 0% | 55-70% | 30-45% |
| 2nd | 55-65% | 3-5% | 30-40% |
| 3rd | 50-60% | 3-5% | 35-45% |
| 4th | 50-60% | 3-5% | 35-45% |
| **Weighted avg** | **~40-50%** | **~15-20%** | **~35-40%** |

Between consecutive user messages (within 5-min TTL), the system prompt + tools are already cached, boosting reads on the first call of the next loop.

For active sessions (messages every 1-3 min): cache read rises to **50-60%**
For longer conversations (10+ turns, large history prefix): cache read can reach **60-70%**

**75% cache read is achievable only for power users in long, active sessions. Fleet-wide average is closer to 50-60%.**

---

## Recommended Values

### For 1,000 users

| Parameter | Current Value | Recommended | Rationale |
|---|---|---|---|
| QPS (rate limit assurance) | 1,200 | **200-400** | See QPS derivation below. 1,200 is 5-10x over peak. Fine if Anthropic doesn't charge for provisioned headroom, but will mislead cost models. |
| Input text tokens per query | 11,133 | **10,000-12,000** | Reasonable blended average across Opus (high) and Haiku (low) calls. See breakdown below. |
| Cache hit % | 75% | **50-60%** | 75% is optimistic. Achievable for individual power users in long sessions, but fleet-wide average is lower due to new conversations, TTL expiry, and short sessions. |
| Cache write % (5-min TTL) | 0% | **10-15%** | Every cache read requires a prior write. First call in each agentic loop writes system prompt + tools + conversation prefix. 5-min ephemeral TTL means re-writes after gaps. |
| Cache write % (60-min TTL) | 0% | **0%** | Correct. The codebase only uses `ephemeral` (5-min) cache. No 60-min breakpoints exist. |
| Output tokens per query | 586 | **400-600** | Blended: tool-use calls are short (~150-300), final responses are longer (~500-1,500), Haiku background calls are short (~200-400). 586 is in the right range. |

### For 5,000 users

Same per-query metrics (architecture-driven, not user-count-driven). Only QPS changes:

| Parameter | 1K Recommended | 5K Recommended |
|---|---|---|
| QPS (rate limit assurance) | 200-400 | **600-1,200** |
| All other parameters | Same | Same |

---

## QPS Derivation

### Conservative (personal assistant usage pattern)
- 1,000 users → 15-25% concurrent at peak → 150-250 active
- Each sends 1 message every 1-2 min → 0.5-1 msg/min
- Each message → 5 LLM calls
- **Peak: 125-250 × 0.75 × 5 / 60 = 8-16 QPS**
- With 3x burst headroom: **25-50 QPS**

### Moderate (mix of personal + automation)
- Some users run watchers (polling external services, triggering LLM on events)
- Some have scheduled tasks
- Adds ~20-30% on top of interactive QPS
- **Peak: 30-65 QPS**

### Aggressive (includes customer-facing bots)
- 5% of users (50) run high-volume bots processing 100+ msg/hr each
- These alone: 50 × 1.67 msg/min × 4 calls / 60 = 5.5 QPS per bot cluster
- Combined with moderate interactive: **150-350 QPS peak**

### Recommendation
- For rate limit assurance: **200-400 QPS** (covers aggressive scenario + 2x headroom)
- For cost modeling: use **30-80 QPS** as realistic sustained average

---

## Per-Model Split (if Anthropic accepts this)

The blended averages hide important cost information. If possible, submit per-model:

| Model | % of Calls | Avg Input Tokens | Avg Output Tokens | QPS Share (of 1K users) |
|---|---|---|---|---|
| Opus (quality-optimized) | ~65% | 15,000-20,000 | 400-800 | ~130-260 |
| Haiku (latency-optimized) | ~30% | 800-1,500 | 200-400 | ~60-120 |
| Sonnet (vision-optimized) | ~5% | 18,000-25,000 | 500-1,500 | ~10-20 |

This matters enormously for cost: Opus is ~15x more expensive than Haiku per token.

---

## Key Assumptions

1. **Conversation depth**: Average 5-8 turns per session. Longer conversations increase input tokens and cache hit rates.
2. **Active skills**: 5-10 skills loaded per session (out of 32 available). More skills = larger system prompt.
3. **Media usage**: ~10-20% of interactions involve images/screenshots (Sonnet). Higher for desktop app users.
4. **Context compaction**: Kicks in at 160K tokens (80% of 200K limit), compacts to ~60K target. Prevents unbounded input growth.
5. **No extended thinking in cost model**: If extended thinking (thinking tokens) is enabled, output tokens increase dramatically (~5-20x). The 400-600 output estimate assumes thinking is billed separately or disabled.
