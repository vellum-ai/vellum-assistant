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
 * The `tree`/`blob` segment is GitHub's own way of expressing a ref + sub-path;
 * when present the segment after it is the ref and the remainder is the
 * sub-path. Otherwise everything past `<owner>/<repo>` is the sub-path and the
 * ref defaults to the repository's default branch ({@link DEFAULT_DIRECT_REF}).
 *
 * The `/tree/<ref>/<path>` form cannot express a ref that contains a slash
 * (`feature/x`): the URL is genuinely ambiguous about where the ref ends and
 * the sub-path begins. Pass `refOverride` (from the CLI's `--ref`) to state the
 * ref explicitly — it then wins over whatever the URL implies, and when the
 * URL's `/tree/<ref>/…` segments start with that ref they are stripped so the
 * remainder is taken as the sub-path.
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

/** Concrete coordinates a direct GitHub install resolves to. */
export interface GitHubPluginSpec {
  readonly owner: string;
  readonly repo: string;
  /** Repo-relative directory holding the plugin root; `""` = repo root. */
  readonly path: string;
  /** Git ref (branch, tag, or commit SHA) to fetch from. */
  readonly ref: string;
  /**
   * Default install name derived from the locator (the sub-path leaf, or the
   * repo name), lower-cased. May still fail {@link sanitizePluginName}, in which
   * case the caller asks the user to supply `--name`.
   */
  readonly defaultName: string;
  /**
   * Raw path segments after `/tree/` (or `/blob/`) when the ref/sub-path split
   * is only a heuristic guess a remote lookup can improve — a `/tree/…` URL with
   * no explicit ref and more than one trailing segment, where the ref could be
   * any leading prefix (a branch like `feature/x` spans several segments). The
   * install path resolves the real split against the repository's ref list,
   * exactly as github.com does; {@link GitHubPluginSpec.ref} /
   * {@link GitHubPluginSpec.path} carry the offline first-segment guess as a
   * fallback for when the remote can't be listed. Absent when the ref is already
   * unambiguous: an explicit `refOverride`, a single trailing segment, the
   * non-`tree` form, or a bare repo.
   */
  readonly ambiguousTreeSegments?: readonly string[];
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
 * Drop `ref`'s own path segments from the front of `segments` when they match,
 * so a copied `/tree/<ref>/<sub/path>` URL yields just the sub-path once the
 * ref is known explicitly. A non-matching prefix (the URL names a different or
 * shorter ref than the override) is left intact — every segment is then the
 * sub-path, since the override already fully specifies the ref.
 */
function stripRefPrefix(segments: string[], ref: string): string[] {
  const refParts = ref.split("/").filter((p) => p.length > 0);
  if (refParts.length === 0 || refParts.length > segments.length) {
    return segments;
  }
  for (let i = 0; i < refParts.length; i++) {
    if (segments[i] !== refParts[i]) return segments;
  }
  return segments.slice(refParts.length);
}

/**
 * Parse a GitHub locator into the coordinates a direct install clones from.
 * Throws {@link InvalidGitHubPluginSpecError} when the string is not a usable
 * GitHub source (wrong host, missing owner/repo, or a sub-path that escapes the
 * repo).
 *
 * `refOverride` (the CLI's `--ref`) disambiguates a ref that contains a slash,
 * which the `/tree/<ref>/<path>` URL form cannot express on its own; when given
 * it becomes the ref verbatim.
 */
export function parseGitHubPluginSpec(
  input: string,
  refOverride?: string,
): GitHubPluginSpec {
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
  const override = refOverride?.trim() || undefined;
  let ref = DEFAULT_DIRECT_REF;
  let pathSegments: string[];
  let ambiguousTreeSegments: readonly string[] | undefined;
  // `/tree/<ref>/<path>` (and the equivalent `/blob/…`) is GitHub's canonical
  // encoding of a ref + sub-path. A ref containing slashes (e.g. `feature/x`)
  // spans several segments, and the URL alone can't say where it ends. github.com
  // resolves this by consulting the repo's refs; an explicit `refOverride`
  // states it directly. Absent both, take the first segment as the ref but
  // surface the raw tail (`ambiguousTreeSegments`) so the install path can
  // resolve the real split against the remote. The non-`tree` form treats
  // everything past the repo as the sub-path.
  if (rest.length > 0 && (rest[0] === "tree" || rest[0] === "blob")) {
    const afterMarker = rest.slice(1);
    if (override) {
      ref = override;
      pathSegments = stripRefPrefix(afterMarker, override);
    } else {
      if (afterMarker.length >= 1) ref = afterMarker[0]!;
      pathSegments = afterMarker.slice(1);
      // Only meaningful when a prefix beyond the first segment could be the ref.
      if (afterMarker.length >= 2) ambiguousTreeSegments = afterMarker;
    }
  } else {
    if (override) ref = override;
    pathSegments = rest;
  }

  for (const seg of pathSegments) {
    if (seg === "." || seg === "..") {
      throw new InvalidGitHubPluginSpecError(
        input,
        "the sub-path must not contain '.' or '..' segments.",
      );
    }
  }

  const path = pathSegments.join("/");
  const leaf = pathSegments.at(-1) ?? repo;
  const defaultName = leaf.toLowerCase();

  return {
    owner,
    repo,
    path,
    ref,
    defaultName,
    ...(ambiguousTreeSegments ? { ambiguousTreeSegments } : {}),
  };
}
