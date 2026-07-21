/**
 * Parse a GitHub locator for an *untrusted* direct plugin install.
 *
 * `assistant plugins install <name>` resolves a single kebab-case segment
 * against the curated `plugins/marketplace.json` whitelist. As a convenience
 * for installing a plugin that is not in that catalog yet — typically one still
 * under development — the same command also accepts a GitHub URL (with an
 * optional sub-path). Such installs bypass marketplace curation entirely, so
 * the caller must surface an untrusted-plugin warning.
 *
 * This module owns only the *parsing*: it turns a locator string into the
 * concrete `owner` / `repo` / sub-`path` / `ref` an install clones from, plus a
 * derived default install name. {@link looksLikeGitHubSpec} is the cheap
 * discriminator the CLI uses to decide whether an argument is a marketplace
 * name or a direct GitHub locator — a marketplace name can never contain a
 * slash, so any slash routes here.
 *
 * Accepted forms (scheme and `github.com` host are optional):
 *   - `https://github.com/<owner>/<repo>`
 *   - `https://github.com/<owner>/<repo>.git`
 *   - `https://github.com/<owner>/<repo>/tree/<ref>/<sub/path>`
 *   - `github.com/<owner>/<repo>/<sub/path>`
 *   - `<owner>/<repo>[/<sub/path>]`
 *
 * The `tree`/`blob` segment is GitHub's own way of expressing a ref + sub-path.
 * The two are joined by a bare `/` with no delimiter, so when the branch name
 * itself contains slashes (`feat/results-viewer`) the boundary between ref and
 * sub-path is ambiguous from the string alone — GitHub resolves it server-side
 * by knowing which refs exist. This parser therefore enumerates every possible
 * split as {@link GitHubPluginSpec.refCandidates} (longest-ref-first) and
 * defaults `ref`/`path` to the shortest-ref split; the caller confirms the real
 * one against the remote (see `resolveTreeRefPath` in `./install-from-github`).
 * Otherwise everything past `<owner>/<repo>` is the sub-path and the ref
 * defaults to the repository's default branch ({@link DEFAULT_DIRECT_REF}).
 */

/**
 * Default git ref a direct install fetches when the locator names none.
 * `HEAD` resolves to the remote's default branch in a single `git fetch`, so no
 * extra API round-trip is needed to discover it.
 */
export const DEFAULT_DIRECT_REF = "HEAD";

/** GitHub owner/org slug: alphanumerics and hyphens. */
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
/** GitHub repo slug: alphanumerics plus `.`, `_`, `-`. */
const REPO_RE = /^[A-Za-z0-9_.-]+$/;

/**
 * One possible split of a `/tree/<ref>/<path>` locator into a concrete ref and
 * sub-path, plus the install name derived from that sub-path. A slashed branch
 * name makes several splits plausible; the remote decides which is real.
 */
export interface GitHubRefPath {
  /** Git ref (branch, tag, or commit SHA) to fetch from. */
  readonly ref: string;
  /** Repo-relative directory holding the plugin root; `""` = repo root. */
  readonly path: string;
  /**
   * Default install name derived from this split (the sub-path leaf, or the
   * repo name), lower-cased. May still fail {@link sanitizePluginName}, in which
   * case the caller asks the user to supply `--name`.
   */
  readonly defaultName: string;
}

/** Concrete coordinates a direct GitHub install resolves to. */
export interface GitHubPluginSpec extends GitHubRefPath {
  readonly owner: string;
  readonly repo: string;
  /**
   * When the locator is a `/tree/<ref>/<path>` form whose ref/path boundary is
   * ambiguous (two or more segments follow `tree`), every possible split,
   * ordered longest-ref-first. The {@link GitHubRefPath.ref}/`path` above are
   * the shortest-ref split — the offline default — while the caller confirms the
   * real split against the remote by picking the first candidate whose ref
   * exists. Absent when there is no ambiguity (a single or no post-`tree`
   * segment, or a non-`tree` locator).
   */
  readonly refCandidates?: readonly GitHubRefPath[];
}

/** The locator could not be parsed as a GitHub plugin source. */
export class InvalidGitHubPluginSpecError extends Error {
  constructor(spec: string, reason: string) {
    super(`Invalid GitHub plugin URL "${spec}". ${reason}`);
    this.name = "InvalidGitHubPluginSpecError";
  }
}

/**
 * Cheap discriminator: is this argument a direct GitHub locator rather than a
 * marketplace install name? Marketplace names are a single kebab-case segment
 * (`/^[a-z0-9][a-z0-9_-]*$/`) and therefore never contain a slash, so the
 * presence of a slash (or an explicit scheme / `github.com` host) routes the
 * argument to {@link parseGitHubPluginSpec}.
 */
export function looksLikeGitHubSpec(arg: string): boolean {
  const s = arg.trim();
  return (
    s.includes("/") ||
    /^https?:\/\//i.test(s) ||
    /(^|\.)github\.com($|\/)/i.test(s)
  );
}

/**
 * Parse a GitHub locator into the coordinates a direct install clones from.
 * Throws {@link InvalidGitHubPluginSpecError} when the string is not a usable
 * GitHub source (wrong host, missing owner/repo, or a sub-path that escapes the
 * repo).
 */
export function parseGitHubPluginSpec(input: string): GitHubPluginSpec {
  const raw = input.trim();
  if (raw === "") {
    throw new InvalidGitHubPluginSpecError(input, "empty locator.");
  }

  let s = raw;

  // Strip an optional scheme. When one is present the next token is the host,
  // which must be github.com — we don't clone arbitrary hosts.
  const scheme = /^https?:\/\//i.exec(s);
  const hadScheme = scheme !== null;
  if (scheme) s = s.slice(scheme[0].length);

  // Strip an optional `github.com` (or `www.github.com`) host prefix.
  const host = /^(?:www\.)?github\.com\//i.exec(s);
  if (host) {
    s = s.slice(host[0].length);
  } else if (hadScheme) {
    throw new InvalidGitHubPluginSpecError(
      input,
      "only github.com URLs are supported.",
    );
  }

  // Drop a query string / fragment and trailing slashes before splitting.
  s = s.split(/[?#]/)[0]!.replace(/\/+$/, "");
  const segments = s.split("/").filter((seg) => seg.length > 0);

  if (segments.length < 2) {
    throw new InvalidGitHubPluginSpecError(
      input,
      "expected github.com/<owner>/<repo> with an optional /tree/<ref>/<path>.",
    );
  }

  const owner = segments[0]!;
  const repo = segments[1]!.replace(/\.git$/i, "");
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo)) {
    throw new InvalidGitHubPluginSpecError(
      input,
      `"${owner}/${repo}" is not a valid owner/repo.`,
    );
  }

  const rest = segments.slice(2);
  let ref = DEFAULT_DIRECT_REF;
  let pathSegments: string[];
  let refCandidates: GitHubRefPath[] | undefined;
  // `/tree/<ref>/<path>` (and the equivalent `/blob/…`) is GitHub's canonical
  // encoding of a ref + sub-path, but the two are joined by a bare `/` with no
  // delimiter — so a ref containing slashes (e.g. `feat/x`) is indistinguishable
  // from a ref plus a leading sub-path segment. Enumerate every split so the
  // caller can pick the real one against the remote; the shortest-ref split is
  // the offline default. The non-`tree` form treats everything past the repo as
  // the sub-path at the default ref.
  if (rest.length > 0 && (rest[0] === "tree" || rest[0] === "blob")) {
    const afterKeyword = rest.slice(1);
    // A '.'/'..' segment can be neither a valid git ref component nor a safe
    // sub-path, so reject it before it can appear on either side of any split.
    assertNoDotSegments(input, afterKeyword);
    if (afterKeyword.length === 0) {
      // `/tree` with nothing after it: the repo root at the default ref.
      pathSegments = [];
    } else {
      // Default split: the shortest ref (first segment after `tree`).
      ref = afterKeyword[0]!;
      pathSegments = afterKeyword.slice(1);
      // Ambiguous only when 2+ segments follow `tree`. Enumerate every split,
      // longest-ref-first, so resolution prefers the longer branch (GitHub's
      // own tie-break; git forbids one branch being a path-prefix of another,
      // so at most one candidate can actually exist on the remote).
      if (afterKeyword.length >= 2) {
        refCandidates = [];
        for (let refLen = afterKeyword.length; refLen >= 1; refLen--) {
          const candidatePath = afterKeyword.slice(refLen);
          refCandidates.push({
            ref: afterKeyword.slice(0, refLen).join("/"),
            path: candidatePath.join("/"),
            defaultName: deriveDefaultName(candidatePath, repo),
          });
        }
      }
    }
  } else {
    pathSegments = rest;
    assertNoDotSegments(input, pathSegments);
  }

  const path = pathSegments.join("/");
  const defaultName = deriveDefaultName(pathSegments, repo);

  return {
    owner,
    repo,
    path,
    ref,
    defaultName,
    ...(refCandidates ? { refCandidates } : {}),
  };
}

/**
 * Throw when any segment is `.` or `..` — a locator sub-path or ref component
 * that could escape the repo root or is not a legal git ref.
 */
function assertNoDotSegments(input: string, segments: readonly string[]): void {
  for (const seg of segments) {
    if (seg === "." || seg === "..") {
      throw new InvalidGitHubPluginSpecError(
        input,
        "the sub-path must not contain '.' or '..' segments.",
      );
    }
  }
}

/** Derive the lower-cased default install name: the sub-path leaf, or the repo. */
function deriveDefaultName(
  pathSegments: readonly string[],
  repo: string,
): string {
  return (pathSegments.at(-1) ?? repo).toLowerCase();
}
