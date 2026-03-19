#!/usr/bin/env bun
/**
 * Generates structured release notes by collecting commits between the previous
 * release tag and HEAD, then using Claude to summarize the top 3-5 highlights.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... bun scripts/generate-release-notes.ts \
 *     --version <semver> --repo <owner/repo> --output <path>
 *
 * On any failure the script falls back to basic build-info-only notes.
 */

import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    version: { type: "string" },
    repo: { type: "string" },
    output: { type: "string" },
  },
  strict: true,
});

const version = values.version;
const repo = values.repo ?? "vellum-ai/vellum-assistant";
const outputPath = values.output ?? "/tmp/release-notes.md";

if (!version) {
  console.error("Error: --version is required");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function git(cmd: string): string {
  return execSync(`git ${cmd}`, { encoding: "utf-8" }).trim();
}

function buildBasicNotes(): string {
  const shortSha = git("rev-parse --short HEAD");
  const fullSha = git("rev-parse HEAD");
  const timestamp = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  return [
    `**Build:** \`${version}\``,
    `**Commit:** [\`${shortSha}\`](https://github.com/${repo}/commit/${fullSha})`,
    `**Built at:** ${timestamp}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const shortSha = git("rev-parse --short HEAD");
  const fullSha = git("rev-parse HEAD");
  const timestamp = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");

  // Find the previous release tag
  const allTags = git("tag -l 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname");
  const prevTag = allTags
    .split("\n")
    .filter(Boolean)
    .find((t) => t !== `v${version}`);

  if (!prevTag) {
    console.log("No previous release tag found, using basic notes");
    writeFileSync(outputPath, buildBasicNotes());
    return;
  }

  console.log(`Previous release: ${prevTag}`);
  console.log(`Collecting commits from ${prevTag}..HEAD...`);

  // Get commit messages between the two tags
  const rawLog = git(`log ${prevTag}..HEAD --pretty=format:"%s" --no-merges`);
  const commits = rawLog
    .split("\n")
    .map((l) => l.replace(/^"|"$/g, "").trim())
    .filter(Boolean)
    .filter((msg) => !/^Release v\d/.test(msg))
    .filter((msg) => !/^Merge /.test(msg));

  if (commits.length === 0) {
    console.log("No commits found between tags, using basic notes");
    writeFileSync(outputPath, buildBasicNotes());
    return;
  }

  console.log(`Found ${commits.length} commits`);

  // Use Claude to generate the release summary
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }

  const client = new Anthropic({ apiKey });

  const commitList = commits.map((c, i) => `${i + 1}. ${c}`).join("\n");

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 64000,
    messages: [
      {
        role: "user",
        content: `You are generating release notes for version ${version} of a software product called "Vellum" (an AI coding assistant). Below are the commit messages included in this release since the last version (${prevTag}). There are ${commits.length} commits total.

Analyze ALL of these commits holistically and produce release notes in the following exact markdown format:

## Highlights
- (exactly 3 to 5 bullet points summarizing the most important user-facing changes in this release)

Rules:
- Synthesize the commits into 3-5 high-level highlights that capture the most significant themes and changes
- Each highlight should be a clear, concise description that a user would understand
- Write in plain english — do not use commit-style prefixes like "feat:" or "fix:"
- Do NOT reference individual PRs or link to specific PR numbers
- Focus on what changed from the user's perspective, grouping related commits into single highlights
- The output should ONLY be the Highlights section — no other sections
- Do not add any text outside of the Highlights section
- Do not wrap the output in a code fence

Here are the commits:

${commitList}`,
      },
    ],
  });

  const content = response.content[0];
  if (content.type !== "text") {
    throw new Error(`Unexpected response type: ${content.type}`);
  }

  let notes = content.text.trim();

  // Append build metadata
  notes += `\n\n---\n\n**Build:** \`${version}\`\n**Commit:** [\`${shortSha}\`](https://github.com/${repo}/commit/${fullSha})\n**Built at:** ${timestamp}`;

  writeFileSync(outputPath, notes);
  console.log("Generated release notes:");
  console.log(notes);
}

try {
  await main();
} catch (error) {
  console.error("Failed to generate LLM release notes, falling back to basic notes:", error);
  writeFileSync(outputPath, buildBasicNotes());
}
