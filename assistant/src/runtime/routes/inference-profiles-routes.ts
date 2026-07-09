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
 * the model must be in the catalog (unless `allowUnlisted`), and a referenced
 * connection must exist. Writes reuse the shared config-write plumbing
 * (`commitConfigWrite` + the managed-profile guards), so a CLI-created profile
 * is completed/materialized identically to a UI-created one.
 */

import { z } from "zod";

import {
  getEffectiveProfile,
  getEffectiveProfiles,
  MANAGED_PROFILE_NAMES,
} from "../../config/default-profile-catalog.js";
import {
  getConfig,
  getConfigReadOnly,
  loadRawConfig,
} from "../../config/loader.js";
import { LLMProvider, ProfileEntry } from "../../config/schemas/llm.js";
import { getDb } from "../../persistence/db-connection.js";
import { computeConnectionAvailability } from "../../providers/inference/connection-availability.js";
import { getConnection } from "../../providers/inference/connections.js";
import { isModelInCatalog } from "../../providers/model-catalog.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import {
  commitConfigWrite,
  normalizeManagedProfileWrites,
  rejectManagedProfileDeletion,
} from "./conversation-query-routes.js";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.js";
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
    status: z.enum([
      "ok",
      "missing_connection",
      "missing_credential",
      "provider_mismatch",
      "unsupported_auth",
      "vellum_unauthenticated",
      "unknown",
    ]),
    message: z.string().optional(),
  })
  .meta({ id: "ProfileConnectionAvailability" });

const profileSummarySchema = z
  .object({
    name: z.string(),
    label: z.string().nullable(),
    provider: z.string().nullable(),
    model: z.string().nullable(),
    status: z.enum(["active", "disabled"]),
    source: z.enum(["managed", "user"]),
    provider_connection: z.string().optional(),
    /** Null when the profile has no connection to judge (e.g. mix profiles). */
    availability: availabilitySchema.nullable(),
  })
  .meta({ id: "InferenceProfileSummary" });

const profileDetailSchema = z
  .object({
    name: z.string(),
    entry: z.record(z.string(), z.unknown()),
    availability: availabilitySchema.nullable(),
  })
  .meta({ id: "InferenceProfileDetail" });

const profileWriteResultSchema = z
  .object({
    ok: z.literal(true),
    name: z.string(),
    entry: z.record(z.string(), z.unknown()),
    warnings: z.array(z.string()),
  })
  .meta({ id: "InferenceProfileWriteResult" });

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
});

// ---------------------------------------------------------------------------
// Validation helpers (daemon is the authority — clients only shape-parse args)
// ---------------------------------------------------------------------------

function assertValidProvider(provider: string): void {
  if (!LLMProvider.safeParse(provider).success) {
    throw new BadRequestError(
      `Invalid provider "${provider}". Valid providers: ${LLMProvider.options.join(", ")}.`,
    );
  }
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
): string[] {
  if (isModelInCatalog(provider, model)) {
    return [];
  }
  if (!allowUnlisted) {
    throw new BadRequestError(
      `Model "${model}" is not in the catalog for provider "${provider}". ` +
        `Pass allowUnlisted to create it anyway, or run ` +
        `"assistant inference models list --provider ${provider}" to see valid ids.`,
    );
  }
  return [
    `Model "${model}" is not in the catalog for provider "${provider}" — created anyway (allowUnlisted).`,
  ];
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
 * Compute connection availability for an effective profile entry — null when
 * there is nothing to judge (no connection or no provider, e.g. mix profiles).
 */
async function profileAvailability(
  entry: Record<string, unknown>,
): Promise<Awaited<ReturnType<typeof computeConnectionAvailability>> | null> {
  const provider = entry.provider;
  const connection = entry.provider_connection;
  if (typeof provider !== "string" || typeof connection !== "string") {
    return null;
  }
  return computeConnectionAvailability(provider, connection);
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

function validateProfileEntry(entry: Record<string, unknown>): void {
  const parsed = ProfileEntry.safeParse(entry);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => issue.message).join("; ");
    throw new BadRequestError(`Invalid profile: ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleListProfiles() {
  const effective = getEffectiveProfiles(getConfigReadOnly().llm.profiles);
  const profiles = await Promise.all(
    Object.entries(effective).map(async ([name, entry]) => {
      const record = entry as Record<string, unknown>;
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
        availability: await profileAvailability(record),
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
  const entry = getEffectiveProfile(getConfigReadOnly().llm.profiles, name);
  if (!entry) {
    throw new NotFoundError(`Profile "${name}" not found.`);
  }
  const record = entry as Record<string, unknown>;
  return {
    name,
    entry: record,
    availability: await profileAvailability(record),
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
  const warnings = validateModel(
    input.provider,
    input.model,
    input.allowUnlisted ?? false,
  );
  if (input.connection) {
    assertConnectionExists(input.connection);
  }

  const entry: Record<string, unknown> = {
    ...fragmentFromBody(body as Record<string, unknown>),
    provider: input.provider,
    model: input.model,
    source: "user",
  };
  validateProfileEntry(entry);

  const raw = loadRawConfig();
  const profiles = ensureRawProfiles(raw);
  if (profiles[name] !== undefined) {
    throw new ConflictError(
      `Profile "${name}" already exists. Use update to modify it.`,
    );
  }
  profiles[name] = entry;
  // Defensive: for a user-owned name this is a no-op; it re-asserts the
  // managed-name protection at the shared write choke point.
  normalizeManagedProfileWrites({ llm: { profiles: { [name]: entry } } });

  await commitConfigWrite(raw, "create inference profile");

  return {
    ok: true as const,
    name,
    entry: (getEffectiveProfile(getConfig().llm.profiles, name) ??
      entry) as Record<string, unknown>,
    warnings,
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
  if (
    (input.provider !== undefined || input.model !== undefined) &&
    typeof nextProvider === "string" &&
    typeof nextModel === "string"
  ) {
    warnings = validateModel(
      nextProvider,
      nextModel,
      input.allowUnlisted ?? false,
    );
  }
  if (input.connection) {
    assertConnectionExists(input.connection);
  }

  const merged: Record<string, unknown> = {
    ...existing,
    ...fragmentFromBody(body as Record<string, unknown>),
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    source:
      existing.source === "managed" ? "user" : (existing.source ?? "user"),
  };
  validateProfileEntry(merged);

  profiles[name] = merged;
  normalizeManagedProfileWrites({ llm: { profiles: { [name]: merged } } });

  await commitConfigWrite(raw, "update inference profile");

  return {
    ok: true as const,
    name,
    entry: (getEffectiveProfile(getConfig().llm.profiles, name) ??
      merged) as Record<string, unknown>,
    warnings,
  };
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
  delete profiles[name];

  await commitConfigWrite(raw, "delete inference profile");

  return { ok: true as const, name };
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
      "Create a validated custom profile. The provider must be a known LLM provider, the model must be in the catalog (unless allowUnlisted), and a referenced connection must exist. Managed default names cannot be created.",
    tags: ["inference"],
    requestBody: createRequestSchema,
    responseBody: profileWriteResultSchema,
    responseStatus: "201",
    additionalResponses: {
      "400": {
        description:
          "Invalid provider, uncataloged model, or missing connection",
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
      "Partial update of a custom profile with the same write-time validation as create. Managed default profiles are read-only.",
    tags: ["inference"],
    pathParams: [{ name: "name", description: "Profile name" }],
    requestBody: updateRequestSchema,
    responseBody: profileWriteResultSchema,
    additionalResponses: {
      "400": {
        description: "Invalid fields, or attempt to edit a managed profile",
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
    },
    handler: handleDeleteProfile,
  },
];
