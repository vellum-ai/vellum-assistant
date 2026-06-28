/**
 * Skill IPC routes for the `host.vectorStore.*` facet.
 *
 * An out-of-process skill obtains a collection handle via `vectorStore.collection`,
 * which the IPC client implements as a one-time `host.vectorStore.ensure` round-trip
 * (provisioning the namespaced collection with the caller's `vectorSize`) followed by
 * per-op `host.vectorStore.{upsert,search,delete}` frames. The collection is namespaced
 * by the owning skill's id (`pluginCollectionName(skillId, name)`) so two skills sharing
 * a logical name never collide — `skillId` travels at the params level, exactly as it
 * does for `host.registries.register_tools`.
 *
 * The daemon side holds no per-call handle state: each frame re-opens the collection.
 * `ensure` records the collection's `vectorSize` in a per-process map so a later op
 * frame — which carries only the collection name — can re-open the handle with the
 * correct dimensionality if the collection still needs lazy creation. The map is
 * repopulated whenever the skill re-acquires the handle (a fresh `ensure`), so it
 * survives daemon restarts without durable state.
 */

import { z } from "zod";

import {
  openPluginVectorCollection,
  pluginCollectionName,
  type PluginVectorPoint,
} from "../../persistence/embeddings/plugin-vector-store.js";
import type { SkillIpcRoute } from "../skill-ipc-types.js";

// -- Param schemas --------------------------------------------------------

const VectorPointSchema = z.object({
  id: z.string(),
  vector: z.array(z.number()),
  payload: z.record(z.string(), z.unknown()).optional(),
});

const VectorStoreEnsureParams = z.object({
  skillId: z.string().min(1),
  name: z.string().min(1),
  vectorSize: z.number().int().positive(),
});

const VectorStoreUpsertParams = z.object({
  skillId: z.string().min(1),
  name: z.string().min(1),
  points: z.array(VectorPointSchema),
});

const VectorStoreSearchParams = z.object({
  skillId: z.string().min(1),
  name: z.string().min(1),
  vector: z.array(z.number()),
  limit: z.number().int().positive(),
});

const VectorStoreDeleteParams = z.object({
  skillId: z.string().min(1),
  name: z.string().min(1),
  ids: z.array(z.string()),
});

// -- vectorSize memo ------------------------------------------------------

/**
 * Per-process map of namespaced collection name → its declared `vectorSize`,
 * populated by `ensure`. An op frame carries only the collection name, so this
 * lets a later op re-open the handle with the right dimensionality when the
 * collection has not yet been lazily created.
 */
const collectionVectorSizes = new Map<string, number>();

/** Fallback dimensionality when an op precedes a recorded `ensure`. */
const DEFAULT_VECTOR_SIZE = 1;

function vectorSizeFor(skillId: string, name: string): number {
  return (
    collectionVectorSizes.get(pluginCollectionName(skillId, name)) ??
    DEFAULT_VECTOR_SIZE
  );
}

// -- Handlers -------------------------------------------------------------

async function handleEnsure(params?: Record<string, unknown>): Promise<void> {
  const { skillId, name, vectorSize } = VectorStoreEnsureParams.parse(params);
  collectionVectorSizes.set(pluginCollectionName(skillId, name), vectorSize);
  await openPluginVectorCollection(skillId, name, vectorSize).ensure();
}

async function handleUpsert(params?: Record<string, unknown>): Promise<void> {
  const { skillId, name, points } = VectorStoreUpsertParams.parse(params);
  await openPluginVectorCollection(
    skillId,
    name,
    vectorSizeFor(skillId, name),
  ).upsert(points as PluginVectorPoint[]);
}

async function handleSearch(params?: Record<string, unknown>) {
  const { skillId, name, vector, limit } =
    VectorStoreSearchParams.parse(params);
  return openPluginVectorCollection(
    skillId,
    name,
    vectorSizeFor(skillId, name),
  ).search(vector, limit);
}

async function handleDelete(params?: Record<string, unknown>): Promise<void> {
  const { skillId, name, ids } = VectorStoreDeleteParams.parse(params);
  await openPluginVectorCollection(
    skillId,
    name,
    vectorSizeFor(skillId, name),
  ).delete(ids);
}

// -- Route definitions ----------------------------------------------------

export const vectorStoreEnsureRoute: SkillIpcRoute = {
  method: "host.vectorStore.ensure",
  handler: handleEnsure,
};

export const vectorStoreUpsertRoute: SkillIpcRoute = {
  method: "host.vectorStore.upsert",
  handler: handleUpsert,
};

export const vectorStoreSearchRoute: SkillIpcRoute = {
  method: "host.vectorStore.search",
  handler: handleSearch,
};

export const vectorStoreDeleteRoute: SkillIpcRoute = {
  method: "host.vectorStore.delete",
  handler: handleDelete,
};

/** All `host.vectorStore.*` IPC routes. */
export const vectorStoreSkillRoutes: SkillIpcRoute[] = [
  vectorStoreEnsureRoute,
  vectorStoreUpsertRoute,
  vectorStoreSearchRoute,
  vectorStoreDeleteRoute,
];
