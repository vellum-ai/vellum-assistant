#!/usr/bin/env bun
/**
 * Count the approximate token count of the compiled system prompt.
 *
 * Usage:
 *   bun scripts/count-system-prompt-tokens.ts [--raw]
 *
 * Options:
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

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    raw: { type: 'boolean', default: false },
  },
  strict: true,
});

const prompt = buildSystemPrompt();

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

console.log(`System prompt stats`);
console.log(`─────────────────────────────────`);
console.log(`  Characters:        ${charCount.toLocaleString()}`);
console.log(`  Words:             ${wordCount.toLocaleString()}`);
console.log(`  Lines:             ${lineCount.toLocaleString()}`);
console.log(`  Estimated tokens:  ~${estimatedTokens.toLocaleString()} (at ~${CHARS_PER_TOKEN} chars/token)`);
