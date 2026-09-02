/**
 * Wire contract for asking an assistant whether its stored platform-managed
 * credential still authenticates.
 *
 * The daemon route is the authoritative serving side:
 *   - `POST /v1/platform/verify-credential`
 *       (`assistant/src/runtime/routes/platform-routes.ts`)
 *
 * The daemon's platform client produces the verdict, the route reports it,
 * and the `vellum` CLI reads it before deciding whether a stored key can be
 * re-injected (`cli/src/lib/assistant-api-key-resolution.ts`), so all three
 * share one definition and cannot silently drift. The web app reads the same
 * shape through its generated daemon client.
 */
import { z } from "zod";

/**
 * What the platform said about the stored credential, right now.
 *
 *   - `valid`: the platform accepted it.
 *   - `rejected`: the platform refused it (unauthorized or forbidden); the
 *     credential needs replacing.
 *   - `unknown`: the check itself could not run (no credential stored, the
 *     platform unreachable, a server error). Not evidence either way.
 */
export const PlatformCredentialVerificationStatusSchema = z.enum([
  "valid",
  "rejected",
  "unknown",
]);
export type PlatformCredentialVerificationStatus = z.infer<
  typeof PlatformCredentialVerificationStatusSchema
>;

/** `POST /v1/platform/verify-credential` response body. */
export const PlatformVerifyCredentialResponseSchema = z.object({
  status: PlatformCredentialVerificationStatusSchema,
});
export type PlatformVerifyCredentialResponse = z.infer<
  typeof PlatformVerifyCredentialResponseSchema
>;
