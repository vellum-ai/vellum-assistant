import { describe, expect, test } from "bun:test";

import { z } from "zod";

import {
  BACKUP_PROFILE_KEYS,
  DEFAULT_PROFILE_KEYS,
  FALLBACK_PROFILE_BY_KEY,
} from "../config/default-profile-names.js";
import { LLMSchema } from "../config/schemas/llm.js";

describe("LLMSchema fallbackProfile", () => {
  test.each([...DEFAULT_PROFILE_KEYS])(
    "accepts the code-owned managed pointer for %s",
    (profileName) => {
      const result = LLMSchema.safeParse({
        defaultProvider: { provider: "vellum" },
        profiles: {
          [profileName]: {
            source: "managed",
            fallbackProfile: FALLBACK_PROFILE_BY_KEY[profileName],
          },
        },
      });
      expect(result.success).toBe(true);
    },
  );

  test("rejects a user-authored fallbackProfile even when its target exists", () => {
    const result = LLMSchema.safeParse({
      profiles: {
        primary: { fallbackProfile: "backup" },
        backup: { speed: "fast" },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) =>
        i.message.includes("Automatic fallbacks are code-owned"),
      );
      expect(issue?.path).toEqual(["profiles", "primary", "fallbackProfile"]);
    }
  });

  test("rejects a fallbackProfile on a user-owned default-profile shadow", () => {
    const profileName = DEFAULT_PROFILE_KEYS[0];
    const result = LLMSchema.safeParse({
      profiles: {
        [profileName]: {
          source: "user",
          fallbackProfile: FALLBACK_PROFILE_BY_KEY[profileName],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  test("rejects a managed default pointing anywhere except its code-owned backup", () => {
    const profileName = DEFAULT_PROFILE_KEYS[0];
    const result = LLMSchema.safeParse({
      profiles: {
        [profileName]: {
          source: "managed",
          fallbackProfile: "custom-backup",
        },
        "custom-backup": { speed: "fast" },
      },
    });
    expect(result.success).toBe(false);
  });

  test("empty-string fallbackProfile is rejected at field level", () => {
    const result = LLMSchema.safeParse({
      profiles: {
        primary: { fallbackProfile: "" },
      },
    });
    expect(result.success).toBe(false);
  });

  test("profiles without fallbackProfile still parse (back-compat)", () => {
    const result = LLMSchema.safeParse({
      profiles: {
        fast: { speed: "fast", effort: "low" },
        thorough: { effort: "high", maxTokens: 128000 },
      },
      callSites: {
        mainAgent: { profile: "thorough" },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.profiles["fast"]?.fallbackProfile).toBeUndefined();
    }
  });

  test("a code-owned fallback pointer is rejected on a non-managed column", () => {
    const profileName = DEFAULT_PROFILE_KEYS[0];
    for (const provider of ["anthropic", "chatgpt"] as const) {
      const result = LLMSchema.safeParse({
        defaultProvider: { provider },
        profiles: {
          [profileName]: {
            source: "managed",
            fallbackProfile: FALLBACK_PROFILE_BY_KEY[profileName],
          },
        },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find((i) =>
          i.path.join(".").endsWith("fallbackProfile"),
        );
        expect(issue?.message).toContain("managed backup profile");
        expect(issue?.path).toEqual([
          "profiles",
          profileName,
          "fallbackProfile",
        ]);
      }
    }
  });

  test("z.toJSONSchema still generates for LLMSchema (config docs/routes)", () => {
    const json = z.toJSONSchema(LLMSchema, {
      unrepresentable: "any",
      io: "input",
    });
    expect(json).toMatchObject({
      properties: {
        profiles: {
          additionalProperties: {
            properties: { fallbackProfile: { readOnly: true } },
          },
        },
      },
    });
  });
});

describe("LLMSchema backup profile references vs llm.defaultProvider", () => {
  const backupKey = BACKUP_PROFILE_KEYS[0];
  const managed = { provider: "vellum" } as const;
  const nonManaged = [{ provider: "anthropic" }, { provider: "chatgpt" }];

  test("activeProfile naming a backup parses on the managed column", () => {
    const result = LLMSchema.safeParse({
      defaultProvider: managed,
      activeProfile: backupKey,
    });
    expect(result.success).toBe(true);
  });

  test("activeProfile naming a backup is rejected on a non-managed column", () => {
    for (const defaultProvider of nonManaged) {
      const result = LLMSchema.safeParse({
        defaultProvider,
        activeProfile: backupKey,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find(
          (i) => i.path.join(".") === "activeProfile",
        );
        expect(issue?.message).toContain("managed backup profile");
      }
    }
  });

  test("advisorProfile naming a backup follows the same split", () => {
    expect(
      LLMSchema.safeParse({
        defaultProvider: managed,
        advisorProfile: backupKey,
      }).success,
    ).toBe(true);
    for (const defaultProvider of nonManaged) {
      const result = LLMSchema.safeParse({
        defaultProvider,
        advisorProfile: backupKey,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some(
            (i) => i.path.join(".") === "advisorProfile",
          ),
        ).toBe(true);
      }
    }
  });

  test("a call-site pin on a backup follows the same split", () => {
    expect(
      LLMSchema.safeParse({
        defaultProvider: managed,
        callSites: { recall: { profile: backupKey } },
      }).success,
    ).toBe(true);
    for (const defaultProvider of nonManaged) {
      const result = LLMSchema.safeParse({
        defaultProvider,
        callSites: { recall: { profile: backupKey } },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find(
          (i) => i.path.join(".") === "callSites.recall.profile",
        );
        expect(issue?.message).toContain("managed backup profile");
      }
    }
  });

  test("a mix arm naming a backup follows the same split", () => {
    const mixConfig = (defaultProvider: { provider: string }) => ({
      defaultProvider,
      profiles: {
        armA: { speed: "fast" },
        blend: {
          mix: [
            { profile: backupKey, weight: 1 },
            { profile: "armA", weight: 1 },
          ],
        },
      },
    });
    expect(LLMSchema.safeParse(mixConfig(managed)).success).toBe(true);
    for (const defaultProvider of nonManaged) {
      expect(LLMSchema.safeParse(mixConfig(defaultProvider)).success).toBe(
        false,
      );
    }
  });

  test("an absent or malformed defaultProvider reads as the managed column", () => {
    // `DefaultProviderField` catches an invalid value to `undefined`, and an
    // install predating the field is managed by definition, so both keep
    // their backups referenceable rather than losing a valid selection.
    for (const defaultProvider of [undefined, { provider: 42 }, "vellum"]) {
      const result = LLMSchema.safeParse({
        defaultProvider,
        activeProfile: backupKey,
      });
      expect(result.success).toBe(true);
    }
  });

  test("the default profile keys stay valid on every column", () => {
    for (const defaultProvider of [managed, ...nonManaged]) {
      for (const key of DEFAULT_PROFILE_KEYS) {
        expect(
          LLMSchema.safeParse({ defaultProvider, activeProfile: key }).success,
        ).toBe(true);
      }
    }
  });

  // A managed install can persist a thin `{ source: "managed" }` stub for a
  // backup key: `normalizeManagedProfileWrites` reduces a `config get` ->
  // `config set` echo of the effective profile list to exactly that. The stub
  // holds no body of its own, so it must not carry a reference past the
  // provider gate once the install moves off the managed column.
  const stub = { source: "managed" } as const;

  test("a managed stub does not keep a backup reference alive off the managed column", () => {
    for (const defaultProvider of nonManaged) {
      const result = LLMSchema.safeParse({
        defaultProvider,
        profiles: { [backupKey]: stub, primary: { effort: "high" } },
        activeProfile: backupKey,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find(
          (i) => i.path.join(".") === "activeProfile",
        );
        expect(issue?.message).toContain("managed backup profile");
      }
    }
  });

  test("a managed stub does not keep a call-site pin or mix arm alive either", () => {
    for (const defaultProvider of nonManaged) {
      const callSitePin = LLMSchema.safeParse({
        defaultProvider,
        profiles: { [backupKey]: stub },
        callSites: { recall: { profile: backupKey } },
      });
      expect(callSitePin.success).toBe(false);

      const mixArm = LLMSchema.safeParse({
        defaultProvider,
        profiles: {
          [backupKey]: stub,
          armA: { speed: "fast" },
          blend: {
            mix: [
              { profile: backupKey, weight: 1 },
              { profile: "armA", weight: 1 },
            ],
          },
        },
      });
      expect(mixArm.success).toBe(false);
    }
  });

  test("a managed stub does not keep a fallbackProfile pointer alive either", () => {
    for (const defaultProvider of nonManaged) {
      const result = LLMSchema.safeParse({
        defaultProvider,
        profiles: {
          [backupKey]: stub,
          primary: { fallbackProfile: backupKey },
        },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find(
          (i) => i.path.join(".") === "profiles.primary.fallbackProfile",
        );
        expect(issue?.message).toContain("Automatic fallbacks are code-owned");
      }
    }
  });

  test("a managed stub keeps its references valid on the managed column", () => {
    // The stub stands for a body that does resolve here, so nothing about it
    // makes the reference worse than the unmaterialized case.
    const result = LLMSchema.safeParse({
      defaultProvider: managed,
      profiles: {
        [backupKey]: stub,
      },
      activeProfile: backupKey,
      callSites: { recall: { profile: backupKey } },
    });
    expect(result.success).toBe(true);
  });

  test("a user-owned entry under a backup name cannot enable custom fallback", () => {
    for (const defaultProvider of [managed, ...nonManaged]) {
      const result = LLMSchema.safeParse({
        defaultProvider,
        profiles: {
          [backupKey]: {
            source: "user",
            provider: "anthropic",
            model: "claude-opus-4-7",
          },
          primary: { fallbackProfile: backupKey },
        },
        activeProfile: backupKey,
      });
      expect(result.success).toBe(false);
    }
  });
});
