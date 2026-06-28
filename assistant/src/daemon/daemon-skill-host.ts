/**
 * `DaemonSkillHost` — in-process concretion of the neutral `SkillHost`
 * interface defined in `@vellumai/skill-host-contracts`.
 *
 * `createDaemonSkillHost(skillId)` returns a plain object whose nine facets
 * (`logger`, `config`, `identity`, `platform`, `providers`, `memory`,
 * `events`, `registries`, `speakers`) delegate to the daemon's existing
 * singleton modules. First-party skills that live in-process receive this
 * host via the bootstrap path instead of reaching into `assistant/` with
 * relative imports.
 *
 * The facet builders are shared with the external-plugin host bundle via
 * `skill-host-facets.ts` so both surfaces construct facets from one source
 * of truth.
 */

import type { SkillHost } from "@vellumai/skill-host-contracts";

import {
  buildConfigFacet,
  buildEmbeddingsFacet,
  buildEventsFacet,
  buildHistoryFacet,
  buildIdentityFacet,
  buildLoggerFacet,
  buildMemoryFacet,
  buildPlatformFacet,
  buildProvidersFacet,
  buildRegistriesFacet,
  buildSpeakersFacet,
  buildVectorStoreFacet,
} from "./skill-host-facets.js";

/**
 * Build a `SkillHost` for the in-process first-party skill identified by
 * `skillId`. The id prefixes logger names (so cross-cutting diagnostics
 * carry the owning skill) and namespaces shutdown-hook registrations (so
 * two skills using the same hook label cannot silently overwrite each
 * other in the shared shutdown-hook map).
 */
export function createDaemonSkillHost(skillId: string): SkillHost {
  return {
    logger: buildLoggerFacet(skillId),
    config: buildConfigFacet(),
    identity: buildIdentityFacet(),
    platform: buildPlatformFacet(),
    providers: buildProvidersFacet(),
    memory: buildMemoryFacet(),
    history: buildHistoryFacet(),
    events: buildEventsFacet(),
    registries: buildRegistriesFacet(skillId),
    speakers: buildSpeakersFacet(),
    embeddings: buildEmbeddingsFacet(),
    vectorStore: buildVectorStoreFacet(skillId),
  };
}
