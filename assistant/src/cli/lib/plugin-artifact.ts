/**
 * Parse a plugin's prebuilt client-artifact descriptor from its
 * `package.json` `vellum.artifact` block.
 *
 * Some plugins ship a native companion the assistant cannot build itself —
 * e.g. a macOS app whose Swift toolchain is absent from the Linux container
 * the daemon runs in. Those plugins publish a prebuilt, author-signed binary
 * out-of-band (a GitHub Release) and point at it from their manifest:
 *
 *     "vellum": {
 *       "artifact": {
 *         "url": "https://github.com/owner/repo/releases/download/v1.0.0/App.dmg",
 *         "sha256": "<64-hex>",
 *         "label": "Download for macOS"
 *       }
 *     }
 *
 * The `url` is mutable (a Release asset can be re-uploaded); the `sha256` is
 * the integrity anchor a client verifies the download against — the same
 * "pin the immutable hash, not the mutable pointer" philosophy the source
 * whitelist already enforces with full commit SHAs.
 *
 * An artifact is only surfaced when **both** fields are well-formed. A
 * missing block, a non-`https:` URL, or an absent / placeholder `sha256`
 * (e.g. the empty string a release workflow fills in on its first run) all
 * resolve to `null` — "no downloadable artifact yet" — so a client never
 * offers an unverifiable download.
 */

import { z } from "zod";

/** A verified, downloadable client artifact declared by a plugin. */
export interface PluginArtifact {
  /** HTTPS URL the artifact is downloaded from. */
  readonly url: string;
  /** Lowercase 64-char hex SHA-256 the download is verified against. */
  readonly sha256: string;
  /**
   * Optional human label for the download affordance — useful when a plugin
   * ships more than one artifact (e.g. "Download for macOS", "Apple Silicon").
   * Absent (or blank) when the plugin doesn't name it; clients fall back to a
   * generic label.
   */
  readonly label?: string;
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * Schema for a complete artifact descriptor. The URL must be absolute and
 * `https:` (an artifact fetched over plaintext defeats the integrity story);
 * the digest must be canonical lowercase hex so client-side comparison is a
 * plain string equality with no normalization step.
 */
const PluginArtifactSchema = z.object({
  url: z
    .string()
    .url()
    .refine((u) => u.startsWith("https://"), {
      message: "artifact url must be an https:// URL",
    }),
  sha256: z
    .string()
    .regex(SHA256_HEX_RE, "artifact sha256 must be 64 lowercase hex chars"),
  // Optional, non-critical metadata: a malformed label must never nullify an
  // otherwise-valid `url` + `sha256`, so a wrong-typed value falls back to
  // `undefined` rather than failing the whole descriptor.
  label: z.string().optional().catch(undefined),
});

/**
 * Read `vellum.artifact` from an already-parsed `package.json` value and
 * return it only when it is a complete, well-formed descriptor. Any shape
 * problem — missing block, wrong types, non-https URL, placeholder/empty
 * `sha256` — yields `null` rather than throwing, so callers can union this
 * across sources without per-source error handling.
 */
export function parsePluginArtifact(
  packageJson: unknown,
): PluginArtifact | null {
  if (
    typeof packageJson !== "object" ||
    packageJson === null ||
    Array.isArray(packageJson)
  ) {
    return null;
  }
  const vellum = (packageJson as Record<string, unknown>).vellum;
  if (typeof vellum !== "object" || vellum === null || Array.isArray(vellum)) {
    return null;
  }
  const artifact = (vellum as Record<string, unknown>).artifact;
  const parsed = PluginArtifactSchema.safeParse(artifact);
  if (!parsed.success) return null;
  // A blank or whitespace-only label is treated as absent so it never
  // invalidates an otherwise well-formed `url` + `sha256` descriptor.
  const label = parsed.data.label?.trim();
  return {
    url: parsed.data.url,
    sha256: parsed.data.sha256,
    ...(label ? { label } : {}),
  };
}

/** Upper bound on `vellum.icon`, in Unicode code points. */
const MAX_ICON_CODE_POINTS = 16;

/**
 * Read `vellum.icon` from an already-parsed `package.json` value and return
 * it only when it is a short, non-empty glyph (an emoji or similar). The
 * value is trimmed and bounded to {@link MAX_ICON_CODE_POINTS} code points so
 * it can never carry markup or a URL. Any other shape — missing block, wrong
 * type, empty, or too long — yields `undefined` rather than throwing.
 */
export function parsePluginIcon(packageJson: unknown): string | undefined {
  if (
    typeof packageJson !== "object" ||
    packageJson === null ||
    Array.isArray(packageJson)
  ) {
    return undefined;
  }
  const vellum = (packageJson as Record<string, unknown>).vellum;
  if (typeof vellum !== "object" || vellum === null || Array.isArray(vellum)) {
    return undefined;
  }
  const icon = (vellum as Record<string, unknown>).icon;
  if (typeof icon !== "string") return undefined;
  const trimmed = icon.trim();
  const codePoints = [...trimmed].length;
  if (codePoints < 1 || codePoints > MAX_ICON_CODE_POINTS) return undefined;
  return trimmed;
}
