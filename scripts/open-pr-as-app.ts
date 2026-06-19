#!/usr/bin/env bun
/**
 * Open a GitHub pull request authored by a GitHub App installation
 * (e.g. vellum-apollo-bot) instead of the connected user account.
 *
 * Why this exists: Claude Code web routes `git`/PR creation through a local
 * proxy bound to the human user's GitHub account, so the built-in "Create PR"
 * always attributes the PR to that user. A PR's author, however, is simply
 * whoever authenticates POST /repos/{owner}/{repo}/pulls. By minting a
 * short-lived installation token from the app's private key and making that
 * call directly against api.github.com, the PR is opened by the app[bot].
 *
 * The branch itself is still pushed via the normal `origin` proxy beforehand.
 *
 * Required env (set these as PRIVATE environment secrets, never commit them):
 *   GH_APP_ID              numeric App ID of vellum-apollo-bot
 *   GH_APP_PRIVATE_KEY     full PEM contents of the app's private key
 *   GH_APP_INSTALLATION_ID optional; auto-resolved from the repo if omitted
 *
 * Usage:
 *   bun scripts/open-pr-as-app.ts \
 *     --head <branch> --base main \
 *     --title "..." --body "..." [--repo owner/name] [--draft]
 */
import { createSign } from "node:crypto";

const API = "https://api.github.com";
const GH_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "open-pr-as-app",
};

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function makeAppJwt(appId: string, pem: string): string {
  const now = Math.floor(Date.now() / 1000);
  // iat backdated 60s to tolerate clock skew; exp capped under GitHub's 10min max.
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(pem);
  return `${signingInput}.${b64url(signature)}`;
}

async function ghJson(url: string, init: RequestInit, bearer: string) {
  const res = await fetch(url, {
    ...init,
    headers: { ...GH_HEADERS, Authorization: `Bearer ${bearer}`, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(`${init.method ?? "GET"} ${url} -> ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

function resolveRepo(): { owner: string; repo: string } {
  const explicit = arg("repo");
  if (explicit) {
    const [owner, repo] = explicit.split("/");
    if (owner && repo) return { owner, repo };
    throw new Error(`--repo must be owner/name, got "${explicit}"`);
  }
  // Derive from the proxy remote URL: .../git/<owner>/<repo>
  const remote = Bun.spawnSync(["git", "remote", "get-url", "origin"]).stdout.toString().trim();
  const m = remote.match(/\/git\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) throw new Error(`Could not parse owner/repo from origin: ${remote}`);
  return { owner: m[1], repo: m[2] };
}

async function main() {
  const appId = process.env.GH_APP_ID;
  const pem = process.env.GH_APP_PRIVATE_KEY;
  if (!appId || !pem) {
    throw new Error("Set GH_APP_ID and GH_APP_PRIVATE_KEY (private env secrets).");
  }

  const head = arg("head");
  const base = arg("base", "main")!;
  const title = arg("title");
  const body = arg("body", "")!;
  if (!head || !title) throw new Error("--head and --title are required.");

  const { owner, repo } = resolveRepo();

  // 1) App JWT -> resolve installation -> short-lived installation token.
  const jwt = makeAppJwt(appId, pem);
  let installationId = process.env.GH_APP_INSTALLATION_ID;
  if (!installationId) {
    const inst = await ghJson(`${API}/repos/${owner}/${repo}/installation`, {}, jwt);
    installationId = String(inst.id);
  }
  const tokenResp = await ghJson(
    `${API}/app/installations/${installationId}/access_tokens`,
    { method: "POST" },
    jwt,
  );
  const installToken: string = tokenResp.token;

  // 2) Open the PR as the app. (Branch must already be pushed to origin.)
  const pr = await ghJson(
    `${API}/repos/${owner}/${repo}/pulls`,
    { method: "POST", body: JSON.stringify({ title, head, base, body, draft: hasFlag("draft") }) },
    installToken,
  );

  console.log(`Opened PR #${pr.number} as ${pr.user?.login}: ${pr.html_url}`);
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
