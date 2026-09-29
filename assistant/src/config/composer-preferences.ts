import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { getDataDir } from "../util/platform.js";

export const ComposerPreferencesSchema = z.object({
  favoriteModeIds: z.array(z.string().min(1).max(200)).max(5).default([]),
  lastModeId: z.string().min(1).max(200).nullable().default(null),
  lastAutonomy: z
    .enum(["none", "low", "medium", "high"])
    .nullable()
    .default(null),
});

export const ComposerPreferencesPatchSchema = z
  .object({
    favoriteModeIds:
      ComposerPreferencesSchema.shape.favoriteModeIds.removeDefault(),
    lastModeId: ComposerPreferencesSchema.shape.lastModeId.removeDefault(),
    lastAutonomy: ComposerPreferencesSchema.shape.lastAutonomy.removeDefault(),
  })
  .partial()
  .strict();
export type ComposerPreferences = z.infer<typeof ComposerPreferencesSchema>;
export type ComposerPreferencesPatch = z.infer<
  typeof ComposerPreferencesPatchSchema
>;

function preferencesPath(principalId: string, dataDir: string): string {
  const key = createHash("sha256").update(principalId).digest("hex");
  return join(dataDir, "composer-preferences", `${key}.json`);
}

export function readComposerPreferences(
  principalId: string,
  dataDir = getDataDir(),
): ComposerPreferences {
  let content: string;
  try {
    content = readFileSync(preferencesPath(principalId, dataDir), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return ComposerPreferencesSchema.parse({});
    }
    throw error;
  }
  const parsed = ComposerPreferencesSchema.safeParse(JSON.parse(content));
  if (!parsed.success) {
    throw new Error("Stored composer preferences are invalid", {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

export function updateComposerPreferences(
  principalId: string,
  patch: ComposerPreferencesPatch,
  dataDir = getDataDir(),
): ComposerPreferences {
  const parsed = ComposerPreferencesSchema.safeParse({
    ...readComposerPreferences(principalId, dataDir),
    ...patch,
  });
  if (!parsed.success) {
    throw new Error("Invalid composer preferences", { cause: parsed.error });
  }
  const preferences = {
    ...parsed.data,
    favoriteModeIds: [...new Set(parsed.data.favoriteModeIds)],
  };
  const directory = join(dataDir, "composer-preferences");
  mkdirSync(directory, { recursive: true });
  const path = preferencesPath(principalId, dataDir);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, JSON.stringify(preferences), {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return preferences;
}
