/**
 * Route definitions for inference-profile CRUD with write-time validation.
 *
 * GET    /v1/inference/profiles        — effective profile catalog (managed defaults + user profiles)
 * GET    /v1/inference/profiles/:name  — single effective profile
 * POST   /v1/inference/profiles        — create a validated custom profile
 * PATCH  /v1/inference/profiles/:name  — partial update of a custom profile
 * DELETE /v1/inference/profiles/:name  — delete a custom profile (managed defaults are protected)
 *
 * Unlike the generic `config set llm.profiles.<name> '<json>'` path, these
 * routes validate at write time: the provider must be a known `LLMProvider`,
 * the model must be in the catalog (unless `allowUnlisted`), a referenced
 * connection must exist, and the resulting profile must be able to dispatch
 * (unless `allowUnavailable`). Writes reuse the shared config-write plumbing
 * (`commitConfigWrite` + the managed-profile guards), so a CLI-created profile
 * is completed/materialized identically to a UI-created one.
 */

import { z } from "zod";

import { validateInferenceProfileConfig } from "../../api/constants/profile-config-validation.js";
import {
  getEffectiveProfilesForProvider,
  MANAGED_PROFILE_NAMES,
  resolveDefaultProfileForProvider,
} from "../../config/default-profile-catalog.js";
import {
  getConfig,
  getConfigReadOnly,
  loadRawConfig,
} from "../../config/loader.js";
import {
  ProfileEntry,
  routingIdentityModelIssue,
} from "../../config/schemas/llm.js";
import { getDb } from "../../persistence/db-connection.js";
import {
  catalogProviderForProfile,
  resolveEntryProviderKind,
  writableProfileProviderIssue,
} from "../../providers/connection-resolution.js";
import { ROUTING_IDENTITY_PROVIDERS } from "../../providers/inference/auth.js";
import type { ConnectionAvailability } from "../../providers/inference/connection-availability.js";
import {
  computeProfileAvailability,
  CONNECTION_AVAILABILITY_STATUSES,
  isUnavailable,
} from "../../providers/inference/connection-availability.js";
import { getConnection } from "../../providers/inference/connections.js";
import { probeInferenceProfile } from "../../providers/inference/profile-probe.js";
import {
  catalogContextWindowTokens,
  catalogMaxOutputTokens,
  getModelDisplayName,
  isModelInCatalog,
} from "../../providers/model-catalog.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import {
  commitConfigWrite,
  normalizeManagedProfileWrites,
  rejectManagedProfileDeletion,
} from "./conversation-query-routes.js";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.js";
import {
  describeUnavailableProfile,
  type ProfileRepairHint,
  unavailableProfileWarning,
  verifyProfileCommand,
} from "./inference-profile-availability-guard.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// Prototype-pollution guards — a profile name may never be one of these.
const RESERVED_PROFILE_NAMES = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

// ---------------------------------------------------------------------------
// Wire schemas
// ---------------------------------------------------------------------------

const availabilitySchema = z
  .object({
    status: z.enum(CONNECTION_AVAILABILITY_STATUSES),
    message: z.string().optional(),
  })
  .meta({ id: "ProfileConnectionAvailability" });

/**
 * Static config problem with the stored entry itself (unknown model,
 * impossible token budget), distinct from `availability` which judges the
 * connection and credential behind it. Absent when the config checks out.
 */
const profileConfigIssueSchema = z
  .object({
    code: z.enum(["model_unknown", "over_output_cap", "no_input_room"]),
    message: z.string(),
  })
  .meta({ id: "InferenceProfileConfigIssue" });

const profileSummarySchema = z
  .object({
    name: z.string(),
    label: z.string().nullable(),
    provider: z.string().nullable(),
    model: z.string().nullable(),
    status: z.enum(["active", "disabled"]),
    source: z.enum(["managed", "user"]),
    provider_connection: z.string().optional(),
    /** Null when the profile has no provider to judge (e.g. mix profiles). */
    availability: availabilitySchema.nullable(),
    config_issue: profileConfigIssueSchema.optional(),
  })
  .meta({ id: "InferenceProfileSummary" });

const profileDetailSchema = z
  .object({
    name: z.string(),
    entry: z.record(z.string(), z.unknown()),
    availability: availabilitySchema.nullable(),
    config_issue: profileConfigIssueSchema.optional(),
  })
  .meta({ id: "InferenceProfileDetail" });

const profileWriteResultSchema = z
  .object({
    ok: z.literal(true),
    name: z.string(),
    entry: z.record(z.string(), z.unknown()),
    warnings: z.array(z.string()),
    /**
     * One-shot command that proves the profile dispatches. The CLI suppresses
     * its human-mode hint under `--json`, which is the mode agents use, so the
     * nudge travels in the payload.
     */
    verify: z.string(),
  })
  .meta({ id: "InferenceProfileWriteResult" });

const profileCheckSchema = z
  .object({
    ok: z.boolean(),
    blame: z.enum(["profile", "provider", "transient", "unknown"]).optional(),
    reason: z.string().optional(),
    detail: z.string().optional(),
    connection: z.string().optional(),
    message: z.string().optional(),
  })
  .meta({ id: "InferenceProfileCheck" });

const createRequestSchema = z.object({
  name: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  connection: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  effort: z.string().optional(),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  thinking: z.boolean().optional(),
  description: z.string().optional(),
  allowUnlisted: z.boolean().optional(),
  allowUnavailable: z.boolean().optional(),
});

const updateRequestSchema = z.object({
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  connection: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  effort: z.string().optional(),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  thinking: z.boolean().optional(),
  description: z.string().optional(),
  allowUnlisted: z.boolean().optional(),
  allowUnavailable: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Validation helpers (daemon is the authority — clients only shape-parse args)
// ---------------------------------------------------------------------------

function assertValidProvider(provider: string): void {
  const issue = writableProfileProviderIssue(provider);
  if (issue) {
    throw new BadRequestError(issue);
  }
}

/**
 * Why a (provider, model, connection) triple cannot be vouched for, or null.
 * The same reach checks dispatch applies: routing identities against their
 * routing table, entry names against their row's dispatchable kind, vendor
 * ids against the catalog, with the named connection's advertised model list
 * authoritative for models the code-owned catalog doesn't know (a custom
 * endpoint declares its own models at connection-create time).
 */
function modelReachIssue(
  provider: string,
  model: string,
  connectionName?: string,
): { identity: boolean; catalogProvider: string; message: string } | null {
  if (ROUTING_IDENTITY_PROVIDERS.has(provider)) {
    const issue = routingIdentityModelIssue(provider, model);
    return issue
      ? { identity: true, catalogProvider: provider, message: issue }
      : null;
  }
  const entryKind = resolveEntryProviderKind(provider, model);
  const catalogProvider = entryKind ?? provider;
  if (isModelInCatalog(catalogProvider, model)) {
    return null;
  }
  const modelListConnection =
    connectionName ?? (entryKind !== null ? provider : undefined);
  if (modelListConnection) {
    const connection = getConnection(getDb(), modelListConnection);
    if (connection?.models?.some((m) => m.id === model)) {
      return null;
    }
  }
  return {
    identity: false,
    catalogProvider,
    message: `Model "${model}" is not in the catalog for provider "${catalogProvider}".`,
  };
}

/**
 * Validate a (provider, model) pair against the catalog. Returns warnings
 * (never throws) when `allowUnlisted`; throws otherwise for an uncataloged
 * model. An uncataloged model always warns, whether or not it is allowed.
 */
function validateModel(
  provider: string,
  model: string,
  allowUnlisted: boolean,
  connectionName?: string,
): string[] {
  const issue = modelReachIssue(provider, model, connectionName);
  if (!issue) {
    return [];
  }
  // allowUnlisted deliberately does not apply to routing identities: the
  // routing table ships in this build, so an unroutable pair fails every
  // request, and the schema strips it on the next config read.
  if (issue.identity) {
    throw new BadRequestError(
      `${issue.message} Pick a model this route serves, or a concrete provider.`,
    );
  }
  if (!allowUnlisted) {
    const remedy =
      issue.catalogProvider === "openai-compatible"
        ? `Pass allowUnlisted to create it anyway, or declare the model on the connection ` +
          `("assistant inference providers update <name> --model ${model}").`
        : `Pass allowUnlisted to create it anyway, or run ` +
          `"assistant inference models list --provider ${provider}" to see valid ids.`;
    throw new BadRequestError(`${issue.message} ${remedy}`);
  }
  return [`${issue.message} Created anyway (allowUnlisted).`];
}

/**
 * Static config verdict for a stored profile: the model-reach and
 * token-budget judgments the write routes enforce, recomputed over the
 * entry so rows that predate validation (or were written through the
 * generic config escape hatch) surface their problem in listings. Cheap
 * and offline; the live probe covers what only a request can prove. Mix
 * arms are judged on their own rows, and managed bodies are code-owned.
 */
function profileConfigIssue(record: Record<string, unknown>): {
  code: "model_unknown" | "over_output_cap" | "no_input_room";
  message: string;
} | null {
  if (record.mix != null || record.source === "managed") {
    return null;
  }
  const provider =
    typeof record.provider === "string" ? record.provider : undefined;
  const model = typeof record.model === "string" ? record.model : undefined;
  if (!provider || !model) {
    // A missing provider/model is availability's `incomplete` verdict.
    return null;
  }
  // A stored allowUnlisted marker records that catalog absence was accepted
  // deliberately at write time; the live probe is the check for those.
  if (record.allowUnlisted !== true) {
    const reach = modelReachIssue(
      provider,
      model,
      typeof record.provider_connection === "string"
        ? record.provider_connection
        : undefined,
    );
    if (reach) {
      return { code: "model_unknown", message: reach.message };
    }
  }
  if (typeof record.maxTokens === "number") {
    const budget = maxTokensBudgetIssue(provider, model, record.maxTokens);
    if (budget) {
      return { code: budget.code, message: budget.message };
    }
  }
  return null;
}

/**
 * The shared token-budget judgment over a (provider, model, maxTokens)
 * triple with the catalog-provider translation applied. Null when the budget
 * passes or the catalog knows nothing to judge against. One implementation
 * for the write routes and the listing verdict so the two cannot drift.
 */
function maxTokensBudgetIssue(
  provider: string,
  model: string,
  maxTokens: number,
): ReturnType<typeof validateInferenceProfileConfig> {
  const catalogProvider = catalogProviderForProfile(provider, model);
  if (catalogProvider === null) {
    return null;
  }
  return validateInferenceProfileConfig({
    maxTokens,
    modelMaxOutputTokens: catalogMaxOutputTokens(catalogProvider, model),
    modelContextWindowTokens: catalogContextWindowTokens(
      catalogProvider,
      model,
    ),
  });
}

function assertConnectionExists(name: string): void {
  if (!getConnection(getDb(), name)) {
    throw new BadRequestError(
      `Connection "${name}" does not exist. Create it first with ` +
        `"assistant inference providers connections create", or omit --connection.`,
    );
  }
}

function asPlainObject(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * Refuse a write that would persist a profile which provably cannot dispatch.
 * Returns the offending verdict when the caller forced the write with
 * `allowUnavailable`, so the handler can warn instead; returns null when the
 * profile is fine or indeterminate.
 */
async function guardProfileAvailability({
  entry,
  repair,
  allowUnavailable,
}: {
  entry: Record<string, unknown>;
  repair: ProfileRepairHint;
  allowUnavailable: boolean;
}): Promise<ConnectionAvailability | null> {
  const availability = await computeProfileAvailability(entry);
  if (!isUnavailable(availability)) {
    return null;
  }
  // isUnavailable() is only true for a non-null verdict.
  const verdict = availability as ConnectionAvailability;
  if (allowUnavailable) {
    return verdict;
  }
  throw new BadRequestError(
    await describeUnavailableProfile({
      availability: verdict,
      provider: String(entry.provider),
      model: typeof entry.model === "string" ? entry.model : undefined,
      repair,
      escapeHatch: repair.kind !== "repoint",
    }),
  );
}

function ensureRawProfiles(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const existingLlm = asPlainObject(raw.llm);
  const llm = existingLlm ?? {};
  if (!existingLlm) {
    raw.llm = llm;
  }
  const existingProfiles = asPlainObject(llm.profiles);
  const profiles = existingProfiles ?? {};
  if (!existingProfiles) {
    llm.profiles = profiles;
  }
  return profiles;
}

/**
 * Build the fragment of profile fields carried by the create/update request
 * body, converting the CLI's flat `thinking` boolean into the schema shape.
 * Only keys present in `body` are set — absent keys are left for the caller
 * to merge (update) or default (create).
 */
function fragmentFromBody(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const fragment: Record<string, unknown> = {};
  if (typeof body.label === "string") {
    fragment.label = body.label;
  }
  if (typeof body.effort === "string") {
    fragment.effort = body.effort;
  }
  if (typeof body.maxTokens === "number") {
    fragment.maxTokens = body.maxTokens;
  }
  if (typeof body.temperature === "number") {
    fragment.temperature = body.temperature;
  }
  if (typeof body.thinking === "boolean") {
    fragment.thinking = { enabled: body.thinking };
  }
  if (typeof body.description === "string") {
    fragment.description = body.description;
  }
  if (typeof body.connection === "string") {
    fragment.provider_connection = body.connection;
  }
  return fragment;
}

/**
 * Enumerate every live reference to profile `name` in the raw `llm` config
 * block: `activeProfile`, `advisorProfile`, each `callSites.<id>.profile`, and
 * every mix arm (`profiles.<mix>.mix[].profile`). Deleting a profile while any
 * of these point at it would leave a dangling reference that `LLMSchema`'s
 * superRefine rejects on the next load — silently resetting the user's chat
 * model or call-site pins. The delete handler rejects instead.
 */
export function collectProfileReferences(
  llm: Record<string, unknown> | null,
  name: string,
): string[] {
  if (!llm) {
    return [];
  }
  const refs: string[] = [];
  if (llm.activeProfile === name) {
    refs.push("llm.activeProfile");
  }
  if (llm.advisorProfile === name) {
    refs.push("llm.advisorProfile");
  }
  const callSites = asPlainObject(llm.callSites);
  if (callSites) {
    for (const [siteId, siteConfig] of Object.entries(callSites)) {
      if (asPlainObject(siteConfig)?.profile === name) {
        refs.push(`llm.callSites.${siteId}`);
      }
    }
  }
  const profiles = asPlainObject(llm.profiles);
  if (profiles) {
    for (const [profileName, profileEntry] of Object.entries(profiles)) {
      const mix = asPlainObject(profileEntry)?.mix;
      if (
        Array.isArray(mix) &&
        mix.some((arm) => asPlainObject(arm)?.profile === name)
      ) {
        refs.push(`llm.profiles.${profileName}.mix`);
      }
    }
  }
  return refs;
}

function validateProfileEntry(entry: Record<string, unknown>): void {
  const parsed = ProfileEntry.safeParse(entry);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => issue.message).join("; ");
    throw new BadRequestError(`Invalid profile: ${detail}`);
  }
}

/**
 * Reject an explicit `maxTokens` the catalog can prove impossible for the
 * model (over its output cap, or reserving the whole context window so no
 * input fits). Judged against the same catalog-provider translation
 * `validateModel` uses; models the catalog does not know are left to the
 * live probe.
 */
function assertSaneMaxTokens(
  provider: string,
  model: string,
  maxTokens: number | undefined,
): void {
  if (maxTokens === undefined) {
    return;
  }
  const issue = maxTokensBudgetIssue(provider, model, maxTokens);
  if (issue) {
    throw new BadRequestError(issue.message);
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleListProfiles() {
  const config = getConfigReadOnly();
  const effective = getEffectiveProfilesForProvider(
    config.llm.profiles,
    config.llm.defaultProvider ?? null,
  );
  const profiles = await Promise.all(
    Object.entries(effective).map(async ([name, entry]) => {
      const record = entry as Record<string, unknown>;
      const configIssue = profileConfigIssue(record);
      return {
        name,
        label: typeof record.label === "string" ? record.label : null,
        provider: typeof record.provider === "string" ? record.provider : null,
        model: typeof record.model === "string" ? record.model : null,
        status: record.status === "disabled" ? "disabled" : "active",
        source: record.source === "managed" ? "managed" : "user",
        ...(typeof record.provider_connection === "string"
          ? { provider_connection: record.provider_connection }
          : {}),
        availability: await computeProfileAvailability(record),
        ...(configIssue ? { config_issue: configIssue } : {}),
      };
    }),
  );
  return { profiles };
}

async function handleGetProfile({ pathParams = {} }: RouteHandlerArgs) {
  const name = (pathParams.name ?? "").trim();
  if (!name) {
    throw new BadRequestError("Profile name must be a non-empty string");
  }
  const config = getConfigReadOnly();
  const entry = resolveDefaultProfileForProvider(
    config.llm.profiles,
    name,
    config.llm.defaultProvider ?? null,
  );
  if (!entry) {
    throw new NotFoundError(`Profile "${name}" not found.`);
  }
  const record = entry as Record<string, unknown>;
  const configIssue = profileConfigIssue(record);
  return {
    name,
    entry: record,
    availability: await computeProfileAvailability(record),
    ...(configIssue ? { config_issue: configIssue } : {}),
  };
}

async function handleCreateProfile({ body = {} }: RouteHandlerArgs) {
  const parsed = createRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError(
      `Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  const input = parsed.data;
  const name = input.name.trim();
  if (!name) {
    throw new BadRequestError("Profile name must be a non-empty string");
  }
  if (RESERVED_PROFILE_NAMES.has(name)) {
    throw new BadRequestError(`Profile name "${name}" is reserved.`);
  }
  if (MANAGED_PROFILE_NAMES.has(name)) {
    throw new BadRequestError(
      `Cannot create profile "${name}" — the name is reserved for a code-defined default profile. Pick a different name.`,
    );
  }

  assertValidProvider(input.provider);
  if (input.connection) {
    assertConnectionExists(input.connection);
  }
  const warnings = validateModel(
    input.provider,
    input.model,
    input.allowUnlisted ?? false,
    input.connection,
  );
  assertSaneMaxTokens(input.provider, input.model, input.maxTokens);

  const entry: Record<string, unknown> = {
    ...fragmentFromBody(body as Record<string, unknown>),
    provider: input.provider,
    model: input.model,
    source: "user",
    // `warnings` here can only be validateModel's unlisted verdict (the
    // availability warning pushes later), so its presence is exactly the
    // deliberate allowUnlisted acceptance the listing verdict must honor.
    ...(input.allowUnlisted && warnings.length > 0
      ? { allowUnlisted: true }
      : {}),
  };
  // Pickers render the label, so a label-less profile shows its raw config
  // key (e.g. "gemini-latest"). Default it to the model's human-readable
  // display name — the catalog's, or the named connection's for custom
  // endpoints — so an unlabeled create still reads well in the UI.
  if (entry.label === undefined) {
    const displayName =
      getModelDisplayName(input.model) ??
      (input.connection
        ? getConnection(getDb(), input.connection)?.models?.find(
            (m) => m.id === input.model,
          )?.displayName
        : undefined);
    if (displayName) {
      entry.label = displayName;
    }
  }
  validateProfileEntry(entry);

  const raw = loadRawConfig();
  const profiles = ensureRawProfiles(raw);
  if (profiles[name] !== undefined) {
    throw new ConflictError(
      `Profile "${name}" already exists. Use update to modify it.`,
    );
  }

  const forced = await guardProfileAvailability({
    entry,
    repair: { kind: "create" },
    allowUnavailable: input.allowUnavailable ?? false,
  });
  if (forced) {
    warnings.push(unavailableProfileWarning(name, forced));
  }

  profiles[name] = entry;
  // Defensive: for a user-owned name this is a no-op; it re-asserts the
  // managed-name protection at the shared write choke point.
  normalizeManagedProfileWrites({ llm: { profiles: { [name]: entry } } });

  await commitConfigWrite(raw, "create inference profile");

  return {
    ok: true as const,
    name,
    entry: (resolveDefaultProfileForProvider(
      getConfig().llm.profiles,
      name,
      getConfig().llm.defaultProvider ?? null,
    ) ?? entry) as Record<string, unknown>,
    warnings,
    verify: verifyProfileCommand(name),
  };
}

async function handleUpdateProfile({
  pathParams = {},
  body = {},
}: RouteHandlerArgs) {
  const name = (pathParams.name ?? "").trim();
  if (!name) {
    throw new BadRequestError("Profile name must be a non-empty string");
  }
  if (RESERVED_PROFILE_NAMES.has(name)) {
    throw new BadRequestError(`Profile name "${name}" is reserved.`);
  }
  const parsed = updateRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError(
      `Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  const input = parsed.data;

  const raw = loadRawConfig();
  const profiles = ensureRawProfiles(raw);
  const existing = asPlainObject(profiles[name]);
  if (!existing) {
    if (MANAGED_PROFILE_NAMES.has(name)) {
      throw new BadRequestError(
        `Cannot edit managed profile "${name}". Managed profiles are read-only; duplicate to a custom profile to customize.`,
      );
    }
    throw new NotFoundError(`Profile "${name}" not found.`);
  }
  if (MANAGED_PROFILE_NAMES.has(name) && existing.source === "managed") {
    throw new BadRequestError(
      `Cannot edit managed profile "${name}". Managed profiles are read-only; duplicate to a custom profile to customize.`,
    );
  }

  const nextProvider =
    input.provider ??
    (typeof existing.provider === "string" ? existing.provider : undefined);
  const nextModel =
    input.model ??
    (typeof existing.model === "string" ? existing.model : undefined);

  if (input.provider) {
    assertValidProvider(input.provider);
  }
  let warnings: string[] = [];
  if (input.connection) {
    assertConnectionExists(input.connection);
  }
  const nextConnection =
    input.connection ??
    (typeof existing.provider_connection === "string"
      ? existing.provider_connection
      : undefined);
  if (
    (input.provider !== undefined || input.model !== undefined) &&
    typeof nextProvider === "string" &&
    typeof nextModel === "string"
  ) {
    warnings = validateModel(
      nextProvider,
      nextModel,
      input.allowUnlisted ?? false,
      nextConnection,
    );
  }
  // Gated on the fields that feed the judgment, mirroring the availability
  // guard: metadata-only edits must not start rejecting a stored budget.
  if (
    (input.maxTokens !== undefined ||
      input.model !== undefined ||
      input.provider !== undefined) &&
    typeof nextProvider === "string" &&
    typeof nextModel === "string"
  ) {
    assertSaneMaxTokens(
      nextProvider,
      nextModel,
      input.maxTokens ??
        (typeof existing.maxTokens === "number"
          ? existing.maxTokens
          : undefined),
    );
  }

  const merged: Record<string, unknown> = {
    ...existing,
    ...fragmentFromBody(body as Record<string, unknown>),
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    source:
      existing.source === "managed" ? "user" : (existing.source ?? "user"),
  };
  // Keep the allowUnlisted marker faithful to the pair being stored: stamp
  // it on a deliberate unlisted acceptance (warnings can only be the
  // unlisted verdict here), and drop a stale one when the pair is now
  // vouched for. Untouched pairs keep their stored marker.
  if (input.provider !== undefined || input.model !== undefined) {
    if (input.allowUnlisted && warnings.length > 0) {
      merged.allowUnlisted = true;
    } else if (warnings.length === 0) {
      delete merged.allowUnlisted;
    }
  }
  validateProfileEntry(merged);

  // The availability guard runs only when the write touches the fields that
  // determine dispatchability (provider/model/connection) — metadata-only
  // edits to a pre-staged profile must not require the escape hatch.
  if (
    input.provider !== undefined ||
    input.model !== undefined ||
    input.connection !== undefined
  ) {
    const forced = await guardProfileAvailability({
      entry: merged,
      repair: { kind: "update" },
      allowUnavailable: input.allowUnavailable ?? false,
    });
    if (forced) {
      warnings.push(unavailableProfileWarning(name, forced));
    }
  }

  profiles[name] = merged;
  normalizeManagedProfileWrites({ llm: { profiles: { [name]: merged } } });

  await commitConfigWrite(raw, "update inference profile");

  return {
    ok: true as const,
    name,
    entry: (resolveDefaultProfileForProvider(
      getConfig().llm.profiles,
      name,
      getConfig().llm.defaultProvider ?? null,
    ) ?? merged) as Record<string, unknown>,
    warnings,
    verify: verifyProfileCommand(name),
  };
}

async function handleValidateProfile({ pathParams = {} }: RouteHandlerArgs) {
  const name = (pathParams.name ?? "").trim();
  if (!name) {
    throw new BadRequestError("Profile name must be a non-empty string");
  }
  return { check: await probeInferenceProfile(name) };
}

async function handleDeleteProfile({ pathParams = {} }: RouteHandlerArgs) {
  const name = (pathParams.name ?? "").trim();
  if (!name) {
    throw new BadRequestError("Profile name must be a non-empty string");
  }

  const raw = loadRawConfig();
  const llm = asPlainObject(raw.llm);
  const profiles = asPlainObject(llm?.profiles);

  // Reject deletion of a managed default with a clear message before the
  // existence check, so `delete balanced` explains itself even when the
  // managed stub is on disk.
  rejectManagedProfileDeletion({ llm: { profiles: { [name]: null } } });

  if (!profiles || profiles[name] === undefined) {
    throw new NotFoundError(`Profile "${name}" not found.`);
  }

  // Refuse deletion while the profile is still referenced. Cascade-deleting the
  // references would silently reset the user's chat model / call-site pins; make
  // the user clear them explicitly instead.
  const references = collectProfileReferences(llm, name);
  if (references.length > 0) {
    throw new ConflictError(
      `Cannot delete profile "${name}" — it is referenced by ${references.join(", ")}. ` +
        `Clear or repoint ${references.length === 1 ? "that reference" : "those references"} first.`,
      { referencedBy: references },
    );
  }

  delete profiles[name];

  await commitConfigWrite(raw, "delete inference profile");

  return { ok: true as const, name };
}

const setActiveRequestSchema = z.object({ name: z.string().min(1) });

async function handleSetActiveProfile({ body = {} }: RouteHandlerArgs) {
  const parsed = setActiveRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError("name must be a non-empty string");
  }
  const name = parsed.data.name.trim();
  if (!name) {
    throw new BadRequestError("Profile name must be a non-empty string");
  }

  // Validate against the same effective catalog the resolver selects from
  // (provider-aware default expansion included), so a typo or a removed name
  // is rejected here instead of silently stripped on the next config load —
  // which would reset the user's chat-model selection.
  const config = getConfigReadOnly();
  const effective = getEffectiveProfilesForProvider(
    config.llm.profiles,
    config.llm.defaultProvider ?? null,
  );
  const entry = effective[name] as Record<string, unknown> | undefined;
  if (!entry) {
    const valid = Object.keys(effective).sort().join(", ");
    throw new BadRequestError(
      `Profile "${name}" does not exist. Valid profiles: ${valid}.`,
    );
  }
  if (entry.status === "disabled") {
    throw new BadRequestError(
      `Profile "${name}" is disabled and cannot be set as the active profile. Enable it first, or pick another.`,
    );
  }
  // No escape hatch here: an active profile that cannot dispatch locks the
  // user out of chat entirely, and nothing about the write signals that.
  await guardProfileAvailability({
    entry,
    repair: { kind: "repoint", profileName: name },
    allowUnavailable: false,
  });

  const raw = loadRawConfig();
  const existingLlm = asPlainObject(raw.llm);
  const llm = existingLlm ?? {};
  if (!existingLlm) {
    raw.llm = llm;
  }
  llm.activeProfile = name;

  await commitConfigWrite(raw, "set active inference profile");

  return { ok: true as const, activeProfile: name };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "inference_profiles_list",
    endpoint: "inference/profiles",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List effective inference profiles",
    description:
      "Return the effective profile catalog: code-defined managed defaults merged with user profiles, each annotated with source and (when it has a connection) availability.",
    tags: ["inference"],
    responseBody: z.object({ profiles: z.array(profileSummarySchema) }),
    handler: handleListProfiles,
  },
  {
    operationId: "inference_profiles_get",
    endpoint: "inference/profiles/:name",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get an effective inference profile",
    description:
      "Return a single effective profile by name, with availability.",
    tags: ["inference"],
    pathParams: [{ name: "name", description: "Profile name" }],
    responseBody: profileDetailSchema,
    additionalResponses: { "404": { description: "Profile not found" } },
    handler: handleGetProfile,
  },
  {
    operationId: "inference_profiles_create",
    endpoint: "inference/profiles",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Create an inference profile",
    description:
      "Create a validated custom profile. The provider must be a known LLM provider, the model must be in the catalog (unless allowUnlisted), a referenced connection must exist, and the profile must be able to dispatch — a valid provider id with no credentialed connection behind it is rejected unless allowUnavailable is set, in which case it is created with a warning.",
    tags: ["inference"],
    requestBody: createRequestSchema,
    responseBody: profileWriteResultSchema,
    responseStatus: "201",
    additionalResponses: {
      "400": {
        description:
          "Invalid provider, uncataloged model, missing connection, or a profile that cannot serve requests",
      },
      "409": { description: "A profile with this name already exists" },
    },
    handler: handleCreateProfile,
  },
  {
    operationId: "inference_profiles_update",
    endpoint: "inference/profiles/:name",
    method: "PATCH",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Update an inference profile",
    description:
      "Partial update of a custom profile with the same write-time validation as create. The dispatch-availability guard (and its allowUnavailable escape hatch) applies when the update changes provider, model, or connection; metadata-only edits skip it. Managed default profiles are read-only.",
    tags: ["inference"],
    pathParams: [{ name: "name", description: "Profile name" }],
    requestBody: updateRequestSchema,
    responseBody: profileWriteResultSchema,
    additionalResponses: {
      "400": {
        description:
          "Invalid fields, a profile that cannot serve requests, or attempt to edit a managed profile",
      },
      "404": { description: "Profile not found" },
    },
    handler: handleUpdateProfile,
  },
  {
    operationId: "inference_profiles_delete",
    endpoint: "inference/profiles/:name",
    method: "DELETE",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Delete an inference profile",
    description:
      "Delete a custom profile. Managed default profiles cannot be deleted (they are re-seeded on boot).",
    tags: ["inference"],
    pathParams: [{ name: "name", description: "Profile name" }],
    responseBody: z.object({ ok: z.literal(true), name: z.string() }),
    additionalResponses: {
      "400": { description: "Attempt to delete a managed profile" },
      "404": { description: "Profile not found" },
      "409": {
        description:
          "Profile is still referenced by activeProfile, advisorProfile, a call site, a default-tier override, or a mix arm",
      },
    },
    handler: handleDeleteProfile,
  },
  {
    operationId: "inference_profiles_set_active",
    endpoint: "inference/active-profile",
    method: "PUT",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Set the active (chat) inference profile",
    description:
      "Set llm.activeProfile after validating the name against the effective profile catalog (provider-aware default expansion included). Unknown or disabled profiles are rejected so the chat-model selection cannot be silently stripped on the next config load. A profile that provably cannot dispatch is also rejected — there is no escape hatch, because an unusable active profile locks the user out of chat.",
    tags: ["inference"],
    requestBody: setActiveRequestSchema,
    responseBody: z.object({
      ok: z.literal(true),
      activeProfile: z.string(),
    }),
    additionalResponses: {
      "400": {
        description:
          "Unknown or disabled profile name, or a profile that cannot serve requests",
      },
    },
    handler: handleSetActiveProfile,
  },
  {
    operationId: "inference_profiles_validate",
    endpoint: "inference/profiles/:name/validate",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Probe a saved profile with one minimal request",
    description:
      "Dispatch one minimal test request through the named profile's resolved model and connection, and classify any failure by which object the user should fix (the profile vs its provider connection). Advisory: the probe never mutates the profile. Returns a null check when there is no verdict to give (missing, disabled, managed, or routing-identity profiles, or a probe timeout). The probe spends one tiny request on the profile's own key.",
    tags: ["inference"],
    pathParams: [{ name: "name", description: "Profile name" }],
    responseBody: z.object({
      check: profileCheckSchema.nullable(),
    }),
    handler: handleValidateProfile,
  },
];
