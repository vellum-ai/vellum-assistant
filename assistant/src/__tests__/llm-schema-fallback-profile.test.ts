import { describe, expect, test } from "bun:test";

import { z } from "zod";

import {
  BACKUP_PROFILE_KEYS,
  DEFAULT_PROFILE_KEYS,
} from "../config/default-profile-names.js";
import { LLMSchema } from "../config/schemas/llm.js";

describe("LLMSchema fallbackProfile", () => {
  test("profile with a valid fallbackProfile pointer parses", () => {
    const result = LLMSchema.safeParse({
      profiles: {
        primary: { effort: "high", fallbackProfile: "backup" },
        backup: { speed: "fast" },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.profiles["primary"]?.fallbackProfile).toBe("backup");
    }
  });

  test("fallbackProfile may reference an always-available default profile key", () => {
    // Code-defined default profiles resolve without being materialized in
    // llm.profiles, so they are valid reference targets (same rule as
    // call-site `profile` references).
    const defaultKey = DEFAULT_PROFILE_KEYS[0];
    const result = LLMSchema.safeParse({
      profiles: {
        primary: { fallbackProfile: defaultKey },
      },
    });
    expect(result.success).toBe(true);
  });

  test("fallbackProfile may reference a managed backup profile key", () => {
    // Backups resolve from the code catalog without being materialized in
    // llm.profiles, exactly like the always-available defaults, so a pointer
    // at one is a valid reference. No `defaultProvider` means the managed
    // column (the reading an install predating the field gets).
    const backupKey = BACKUP_PROFILE_KEYS[0];
    const result = LLMSchema.safeParse({
      profiles: {
        primary: { fallbackProfile: backupKey },
      },
    });
    expect(result.success).toBe(true);
  });

  test("dangling fallbackProfile pointer fails superRefine", () => {
    const result = LLMSchema.safeParse({
      profiles: {
        primary: { fallbackProfile: "ghost" },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) =>
        i.message.includes('fallbackProfile "ghost"'),
      );
      expect(issue?.message).toContain("is not defined in llm.profiles");
      expect(issue?.path).toEqual(["profiles", "primary", "fallbackProfile"]);
    }
  });

  test("self-referencing fallbackProfile is rejected", () => {
    const result = LLMSchema.safeParse({
      profiles: {
        primary: { fallbackProfile: "primary" },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) =>
        i.message.includes("cannot declare itself"),
      );
      expect(issue?.path).toEqual(["profiles", "primary", "fallbackProfile"]);
    }
  });

  test("fallbackProfile pointing at a mix profile is rejected", () => {
    const result = LLMSchema.safeParse({
      profiles: {
        primary: { fallbackProfile: "blend" },
        armA: { speed: "fast" },
        armB: { effort: "high" },
        blend: {
          mix: [
            { profile: "armA", weight: 1 },
            { profile: "armB", weight: 1 },
          ],
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) =>
        i.message.includes("is a mix profile"),
      );
      expect(issue?.path).toEqual(["profiles", "primary", "fallbackProfile"]);
    }
  });

  test("two-hop fallback chain is rejected (single hop only)", () => {
    const result = LLMSchema.safeParse({
      profiles: {
        primary: { fallbackProfile: "middle" },
        middle: { fallbackProfile: "last" },
        last: { speed: "fast" },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) =>
        i.message.includes("chains are not allowed"),
      );
      expect(issue?.path).toEqual(["profiles", "primary", "fallbackProfile"]);
    }
  });

  test("mix profile carrying fallbackProfile is rejected", () => {
    const result = LLMSchema.safeParse({
      profiles: {
        armA: { speed: "fast" },
        armB: { effort: "high" },
        blend: {
          mix: [
            { profile: "armA", weight: 1 },
            { profile: "armB", weight: 1 },
          ],
          fallbackProfile: "armA",
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) =>
        i.message.includes('cannot also set "fallbackProfile"'),
      );
      expect(issue?.path).toEqual(["profiles", "blend", "fallbackProfile"]);
    }
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

  test("a backup fallbackProfile target is rejected on a non-managed column", () => {
    // The backups exist only on the managed column, so under a BYOK or
    // ChatGPT default provider the pointer names a target that can never
    // resolve, and keeping it would leave the primary silently unprotected.
    const backupKey = BACKUP_PROFILE_KEYS[0];
    for (const provider of ["anthropic", "chatgpt"] as const) {
      const result = LLMSchema.safeParse({
        defaultProvider: { provider },
        profiles: {
          primary: { fallbackProfile: backupKey },
        },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find((i) =>
          i.message.includes(`fallbackProfile "${backupKey}"`),
        );
        expect(issue?.message).toContain("managed backup profile");
        expect(issue?.path).toEqual(["profiles", "primary", "fallbackProfile"]);
      }
    }
  });

  test("a user-owned materialized backup entry is a valid target on any column", () => {
    // Conditioning applies to the code-defined name, not to a user-owned
    // workspace entry: that entry carries its own body, and with no
    // code-owned body to lose on a BYOK column it is what the name resolves
    // to, so a pointer at it stays valid. A `source` other than `managed`,
    // absent included, is what makes an entry user-owned, matching
    // `resolveAgainstBody`.
    const backupKey = BACKUP_PROFILE_KEYS[0];
    const result = LLMSchema.safeParse({
      defaultProvider: { provider: "anthropic" },
      profiles: {
        primary: { fallbackProfile: backupKey },
        [backupKey]: { provider: "anthropic", model: "claude-opus-4-7" },
      },
    });
    expect(result.success).toBe(true);
  });

  test("z.toJSONSchema still generates for LLMSchema (config docs/routes)", () => {
    // Same options as handleGetConfigSchema in
    // runtime/routes/conversation-query-routes.ts. The field must not
    // introduce any callback-bearing zod construct that breaks generation.
    const json = z.toJSONSchema(LLMSchema, {
      unrepresentable: "any",
      io: "input",
    });
    expect(json).toBeTruthy();
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
        expect(issue?.message).toContain("managed backup profile");
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
        primary: { fallbackProfile: backupKey },
      },
      activeProfile: backupKey,
      callSites: { recall: { profile: backupKey } },
    });
    expect(result.success).toBe(true);
  });

  test("a user-owned entry under a backup name keeps its references on every column", () => {
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
      expect(result.success).toBe(true);
    }
  });
});
