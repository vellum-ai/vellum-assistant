import { execFileSync } from "node:child_process";

export function resolveBuildCommitSha(): string {
  const githubSha = process.env.GITHUB_SHA?.trim();
  if (githubSha) {
    return githubSha;
  }
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    return sha || "unknown";
  } catch {
    return "unknown";
  }
}

export function resolveShortBuildCommitSha(): string {
  const sha = resolveBuildCommitSha();
  return sha === "unknown" ? sha : sha.slice(0, 7);
}
