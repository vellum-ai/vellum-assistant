/**
 * Default `post-tool-use` hook for the pr-link-injector plugin.
 *
 * Inspects bash tool calls for `git push` and, when found, resolves the
 * current branch's PR URL via the GitHub API. The URL is stored in the
 * per-conversation pr-link-store so the sibling `post-model-call` hook can
 * inject it into the final reply if the model didn't already mention it.
 *
 * Detection is best-effort: if the GitHub API call fails (no token, network
 * error, no PR for the branch), the hook silently moves on. The hook only
 * fires on successful (non-error) bash results — a failed push doesn't
 * produce a PR.
 */

import { execSync } from "node:child_process";

import type { PluginHookFn, PostToolUseContext } from "@vellumai/plugin-api";

import type { Message, ToolUseContent } from "../../../../providers/types.js";
import { getPrLink, setPrLink } from "../pr-link-store.js";

/** Match `git push` in a bash command string. */
const GIT_PUSH_RE = /\bgit\s+push\b/;

/** Tokens to skip when parsing `git push` positional args. */
const REMOTE_NAMES = new Set(["origin", "upstream", "github"]);

/**
 * Extract the branch name from a `git push` command. Handles the common forms:
 *   - `git push origin <branch>` — second positional is the branch
 *   - `git push <branch>` — first positional is the branch
 *   - `git push` or `git push origin` — null (use current branch)
 */
function extractBranchFromPushCommand(command: string): string | null {
  const pushIdx = command.search(GIT_PUSH_RE);
  if (pushIdx === -1) return null;

  const afterPush = command.slice(pushIdx).replace(GIT_PUSH_RE, "");
  const tokens = afterPush.trim().split(/\s+/).filter(Boolean);

  // Skip flag tokens (start with -).
  const positional: string[] = [];
  for (const tok of tokens) {
    if (tok.startsWith("-")) continue;
    positional.push(tok);
  }

  if (positional.length >= 2) return positional[1]!;
  if (positional.length === 1 && !REMOTE_NAMES.has(positional[0]!)) {
    return positional[0]!;
  }
  return null;
}

/** Find the tool_use block matching a tool_result's tool_use_id in history. */
function findToolUseBlock(
  messages: ReadonlyArray<Message>,
  toolUseId: string,
): ToolUseContent | null {
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content) {
      if (block.type === "tool_use" && block.id === toolUseId) {
        return block;
      }
    }
  }
  return null;
}

/** Extract the GitHub token from a git remote URL. */
function extractGithubToken(remoteUrl: string): string | null {
  const match = remoteUrl.match(
    /https:\/\/x-access-token:([^@]+)@github\.com\//,
  );
  return match?.[1] ?? null;
}

/** Extract owner/repo from a GitHub remote URL. */
function extractOwnerRepo(
  remoteUrl: string,
): { owner: string; repo: string } | null {
  const match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.\s]+)/);
  if (match) return { owner: match[1]!, repo: match[2]! };
  return null;
}

/**
 * Resolve the PR URL for a branch via the GitHub API.
 * Returns the PR HTML URL or null if not found / API failed.
 */
async function resolvePrUrl(
  owner: string,
  repo: string,
  branch: string,
  token: string,
): Promise<string | null> {
  try {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls?head=${owner}:${branch}&state=open`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const prs = (await res.json()) as Array<{ html_url: string }>;
    if (prs.length === 0) return null;
    return prs[0]!.html_url;
  } catch {
    return null;
  }
}

const postToolUse: PluginHookFn<PostToolUseContext> = async (ctx) => {
  // Only inspect successful bash results.
  if (ctx.toolResponse.is_error === true) return;

  // Already found a PR for this conversation this run.
  if (getPrLink(ctx.conversationId)) return;

  // Find the tool_use block to get the command.
  const toolUse = findToolUseBlock(ctx.messages, ctx.toolResponse.tool_use_id);
  if (!toolUse || (toolUse.name !== "bash" && toolUse.name !== "host_bash")) {
    return;
  }

  const command = (toolUse.input as { command?: string }).command;
  if (!command || !GIT_PUSH_RE.test(command)) return;

  // Extract branch from the command, or fall back to current branch.
  let branch = extractBranchFromPushCommand(command);
  if (!branch) {
    // Try to get the current branch from the cwd. The bash tool runs in a
    // specific directory — we can try `git rev-parse --abbrev-ref HEAD` from
    // the push command's cwd if available, but that's complex. For now, skip
    // if we can't determine the branch.
    try {
      branch = execSync("git rev-parse --abbrev-ref HEAD", {
        encoding: "utf-8",
        timeout: 5_000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return;
    }
  }

  // Get the remote URL to extract token + owner/repo.
  let remoteUrl: string;
  try {
    remoteUrl = execSync("git remote get-url origin", {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return;
  }

  const token = extractGithubToken(remoteUrl);
  if (!token) return;

  const ownerRepo = extractOwnerRepo(remoteUrl);
  if (!ownerRepo) return;

  const prUrl = await resolvePrUrl(
    ownerRepo.owner,
    ownerRepo.repo,
    branch,
    token,
  );
  if (prUrl) {
    setPrLink(ctx.conversationId, prUrl);
    ctx.logger.info(
      { plugin: "pr-link-injector", conversationId: ctx.conversationId, prUrl },
      "Detected git push, resolved PR URL",
    );
  }
};

export default postToolUse;
