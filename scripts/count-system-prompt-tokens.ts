#!/usr/bin/env bun
/**
 * Count the approximate token count of the compiled system prompt.
 *
 * Usage:
 *   bun scripts/count-system-prompt-tokens.ts [--tier high|medium|low] [--raw]
 *
 * Options:
 *   --tier <tier>   Response tier to build (default: high)
 *   --raw           Print the raw compiled prompt to stdout instead of stats
 *
 * This imports buildSystemPrompt() from the assistant package and runs it
 * against the live workspace files (~/.vellum/workspace/).
 */

import { parseArgs } from 'node:util';

// buildSystemPrompt depends on modules that resolve workspace paths from
// ~/.vellum/workspace, config, skills, etc. Import it directly so we get
// the real compiled prompt.
import { buildSystemPrompt } from '../assistant/src/config/system-prompt.js';
import type { ResponseTier } from '../assistant/src/daemon/response-tier.js';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    tier: { type: 'string', default: 'high' },
    raw: { type: 'boolean', default: false },
  },
  strict: true,
});

const tier = (values.tier ?? 'high') as ResponseTier;

if (!['low', 'medium', 'high'].includes(tier)) {
  console.error(`Invalid tier: ${tier}. Must be one of: low, medium, high`);
  process.exit(1);
}

const prompt = buildSystemPrompt(tier);

if (values.raw) {
  process.stdout.write(prompt);
  process.exit(0);
}

// Token estimation: Claude models use a BPE tokenizer similar to cl100k_base.
// Empirically, English prose averages ~3.5–4 characters per token. We use 3.7
// as a middle-ground estimate. For a precise count, pipe --raw output through
// the Anthropic token counting API.
const CHARS_PER_TOKEN = 3.7;

const charCount = prompt.length;
const lineCount = prompt.split('\n').length;
const wordCount = prompt.split(/\s+/).filter(Boolean).length;
const estimatedTokens = Math.round(charCount / CHARS_PER_TOKEN);

console.log(`System prompt stats (tier: ${tier})`);
console.log(`─────────────────────────────────`);
console.log(`  Characters:        ${charCount.toLocaleString()}`);
console.log(`  Words:             ${wordCount.toLocaleString()}`);
console.log(`  Lines:             ${lineCount.toLocaleString()}`);
console.log(`  Estimated tokens:  ~${estimatedTokens.toLocaleString()} (at ~${CHARS_PER_TOKEN} chars/token)`);
console.log();
console.log(`Tip: Use --raw to dump the full prompt, or --tier low|medium to compare tiers.`);
