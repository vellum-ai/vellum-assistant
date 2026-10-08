import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const KeySchema = z.string().regex(/^[0-9a-f]{64}$/i);
const ResourcesSchema = z.object({
  instanceDir: z.string().min(1),
  signingKey: KeySchema.optional(),
});

export class SigningKeyContinuityError extends Error {
  constructor(
    public readonly code: "missing" | "invalid" | "unreadable" | "conflict",
  ) {
    super(
      `Cannot resume authentication: signing key ${code}. Preserve the existing authentication state and restore its original key; no replacement key was generated.`,
    );
    this.name = "SigningKeyContinuityError";
  }
}

/** Resolve existing identity material. This operation never creates or rotates a key. */
export function resolveExistingLocalSigningKey(
  resources: unknown,
  legacyVellumDir?: string,
): string {
  const parsed = ResourcesSchema.safeParse(resources);
  if (!parsed.success) {
    throw new SigningKeyContinuityError("invalid");
  }
  const { instanceDir, signingKey } = parsed.data;
  // The host registry is authoritative after provisioning or migration.
  // Legacy files can be stale after an explicit identity repair.
  if (signingKey) {
    return signingKey.toLowerCase();
  }
  const candidates: Buffer[] = [];
  const vellumDir = legacyVellumDir ?? join(instanceDir, ".vellum");
  // Read-only migration sources, scoped to this instance rather than the user's home.
  const legacyPaths = [
    join(vellumDir, "protected", "actor-token-signing-key"),
    join(vellumDir, "workspace", "deprecated", "actor-token-signing-key"),
  ];
  for (const keyPath of legacyPaths) {
    let raw: Buffer;
    try {
      raw = readFileSync(keyPath);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }
      throw new SigningKeyContinuityError("unreadable");
    }
    if (raw.length !== 32) {
      throw new SigningKeyContinuityError("invalid");
    }
    candidates.push(raw);
  }
  const key = candidates[0];
  if (!key) {
    throw new SigningKeyContinuityError("missing");
  }
  if (candidates.some((candidate) => !timingSafeEqual(candidate, key))) {
    throw new SigningKeyContinuityError("conflict");
  }
  return key.toString("hex");
}
