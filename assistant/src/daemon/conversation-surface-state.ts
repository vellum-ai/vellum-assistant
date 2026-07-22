// Surface state types and the correlated-pair helpers that build/restore
// them. Kept in a standalone module — with only lightweight imports
// (`api/surfaces`, telemetry tag validation, a plain-object guard) — so
// consumers that just need to parse or restore a surface entry (e.g. the
// surface route resolver) don't pull in the heavy `conversation-surfaces`
// dependency graph and create an import cycle.

import {
  coerceSurfaceDataRecord,
  safeParseSurfaceData,
  type SurfaceDataByType,
  type SurfaceType,
  SurfaceTypeSchema,
} from "../api/surfaces.js";
import {
  type ActivationMomentParam,
  isActivationMomentParam,
} from "../telemetry/activation-funnel.js";
import { isPlainObject } from "../util/object.js";

/** Action snapshot stored with a surface (style stays a loose string). */
export interface StoredSurfaceAction {
  id: string;
  label: string;
  style?: string;
  data?: Record<string, unknown>;
}

/**
 * A correlated `surfaceType`/`data` pair per surface type. Generic code
 * indexes the map (`SurfaceShowPairMap[K]`) so the compiler keeps the
 * pairing; checking `pair.surfaceType` narrows `pair.data`.
 */
type SurfaceShowPairMap = {
  [K in SurfaceType]: { surfaceType: K; data: SurfaceDataByType[K] };
};

/** Union of all correlated `surfaceType`/`data` pairs. */
export type SurfaceShowPair = SurfaceShowPairMap[SurfaceType];

/**
 * One live surface's stored state; `surfaceType` narrows `data`, so readers
 * guard on the discriminant instead of casting.
 */
export type SurfaceStateEntry = {
  [K in SurfaceType]: {
    surfaceType: K;
    data: SurfaceDataByType[K];
    title?: string;
    actions?: StoredSurfaceAction[];
    /**
     * Activation-rail telemetry tag (daemon-only). When the model tags a
     * `ui_show` surface as an activation funnel moment, the token is captured
     * here so the milestone can be recorded deterministically when the user
     * commits the surface (`handleSurfaceAction`). Never forwarded to the
     * client.
     */
    activationMoment?: ActivationMomentParam;
  };
}[SurfaceType];

/** A surface shown during the current turn, tracked for message persistence. */
export type CurrentTurnSurface = {
  [K in SurfaceType]: {
    surfaceId: string;
    surfaceType: K;
    title?: string;
    data: SurfaceDataByType[K];
    actions?: StoredSurfaceAction[];
    display?: string;
    persistent?: boolean;
    toolCallId?: string;
    /**
     * Commit-timing activation-rail tag (daemon-only). Carried through to the
     * persisted `ui_surface` history block so it survives a reload — never sent
     * to the client.
     */
    activationMoment?: ActivationMomentParam;
  };
}[SurfaceType];

/**
 * Recover a correlated show pair from an untyped (`surfaceType`, `data`)
 * pairing — a persisted history block, or a loosely-typed tool message.
 * Returns `undefined` when `surfaceType` isn't a known surface type; the
 * data parses tolerantly through the type's canonical schema.
 */
export function parseSurfaceShowPair(
  surfaceType: unknown,
  data: unknown,
): SurfaceShowPair | undefined {
  const parsedType = SurfaceTypeSchema.safeParse(surfaceType);
  if (!parsedType.success) {
    return undefined;
  }
  return buildSurfaceShowPair(parsedType.data, data);
}

/** Correlated-pair constructor for a known surface type. */
export function buildSurfaceShowPair<K extends SurfaceType>(
  surfaceType: K,
  data: unknown,
): SurfaceShowPairMap[K] | undefined {
  const parsed = safeParseSurfaceData(surfaceType, data);
  if (parsed === undefined) {
    return undefined;
  }
  // `parsed` came from `surfaceType`'s own schema, so the pair is correlated
  // by construction; TypeScript cannot verify an object literal against a
  // generic indexed type (microsoft/TypeScript#30581), so this single
  // assertion is the one place untyped pairs become typed ones.
  return { surfaceType, data: parsed } as SurfaceShowPairMap[K];
}

/**
 * Correlated-pair constructor for surface types whose schemas are total
 * over object inputs (every type except `card`). The throw is unreachable
 * for record payloads; it exists so a schema regression fails loudly
 * instead of rendering the wrong surface.
 */
export function parseShowPairOrThrow<K extends SurfaceType>(
  surfaceType: K,
  data: Record<string, unknown>,
): SurfaceShowPairMap[K] {
  const pair = buildSurfaceShowPair(surfaceType, data);
  if (pair === undefined) {
    throw new Error(
      `ui_show data for "${surfaceType}" failed its canonical schema`,
    );
  }
  return pair;
}

/**
 * Parse a persisted/loose `actions` value into stored actions, dropping
 * entries without a string `id` and `label`. Returns `undefined` for a
 * non-array so an actionless surface stays actionless.
 */
export function parseStoredActions(
  value: unknown,
): StoredSurfaceAction[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.flatMap((action): StoredSurfaceAction[] => {
    if (!isPlainObject(action)) {
      return [];
    }
    const { id, label, style, data } = action;
    if (typeof id !== "string" || typeof label !== "string") {
      return [];
    }
    return [
      {
        id,
        label,
        ...(typeof style === "string" ? { style } : {}),
        ...(isPlainObject(data) ? { data } : {}),
      },
    ];
  });
}

/**
 * The daemon-only commit-timing activation tag from a persisted block,
 * validated and dropped if malformed. This field never reaches the client.
 */
export function parseActivationMomentTag(
  value: unknown,
): ActivationMomentParam | undefined {
  return typeof value === "string" && isActivationMomentParam(value)
    ? value
    : undefined;
}

/**
 * Map a persisted `ui_surface` history block to a live `surfaceState`
 * entry. The block's fields are untyped JSON from the messages table; the
 * `surfaceType`/`data` pair parses through the canonical schemas so the
 * live entry is typed. An unrecognized `surfaceType` falls back to
 * `dynamic_page` (the legacy restore default for blocks that predate the
 * field); a card payload that fails its schema (the one non-total schema)
 * restores as an empty card rather than flipping type.
 *
 * This is for the LIVE, daemon-manipulated map. Read-only persistence
 * views that serve data verbatim to a client must NOT use it — canonical
 * schemas strip keys the daemon does not model; see
 * `findPersistedSurfaceState`.
 */
export function restoreSurfaceStateEntry(
  b: Record<string, unknown>,
): SurfaceStateEntry {
  const parsedType = SurfaceTypeSchema.safeParse(
    b.surfaceType ?? "dynamic_page",
  );
  const surfaceType = parsedType.success ? parsedType.data : "dynamic_page";
  const pair = buildSurfaceShowPair(
    surfaceType,
    coerceSurfaceDataRecord(b.data),
  ) ?? { surfaceType: "card", data: {} };

  const activationMoment = parseActivationMomentTag(b.activationMoment);

  return {
    title: typeof b.title === "string" ? b.title : undefined,
    actions: parseStoredActions(b.actions),
    ...(activationMoment ? { activationMoment } : {}),
    ...pair,
  };
}
