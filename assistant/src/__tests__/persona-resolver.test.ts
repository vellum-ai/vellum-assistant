/**
 * Tests for persona-resolver helpers used by the drop-user-md migration:
 * `resolveGuardianPersonaPath` and `ensureGuardianPersonaFile`.
 *
 * The module under test reads/writes files under `getWorkspaceDir()`,
 * so these tests stub `util/platform.js` to point at an ephemeral temp
 * directory and stub `contacts/contact-store.js` to control which
 * guardian (if any) is returned by the resolver.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

// ── Mock state ────────────────────────────────────────────────────

interface GuardianDeliveryStub {
  channelType: string;
  address: string;
  status: string;
}

let mockWorkspaceDir: string = "";
// Gateway guardian delivery cache, keyed by the same source the production
// peek reads; the guardian's userFile (local INFO) is joined separately via
// findContactByAddress on the delivery's address.
let mockGuardianDeliveries: GuardianDeliveryStub[] = [];
let mockContactsByAddress: Record<string, { userFile: string | null }> = {};
// Simulates a cold sync cache: the sync `peek` returns nothing until the async
// `getGuardianDelivery` warm runs and populates `mockGuardianDeliveries`. The
// pending list is what the warm reveals.
let pendingWarmDeliveries: GuardianDeliveryStub[] | null = null;

/**
 * Seed a vellum guardian: a gateway delivery for the vellum channel plus the
 * local contact (by address) carrying its userFile.
 */
function seedVellumGuardian(userFile: string | null): void {
  mockGuardianDeliveries = [
    { channelType: "vellum", address: "vellum:self", status: "active" },
  ];
  mockContactsByAddress["vellum:vellum:self"] = { userFile };
}

// ── Mock modules (must precede imports from the module under test) ──

mock.module("../util/platform.js", () => ({
  getWorkspaceDir: () => mockWorkspaceDir,
}));

mock.module("../contacts/contact-store.js", () => ({
  findContactByAddress: (channelType: string, address: string) =>
    mockContactsByAddress[`${channelType}:${address}`] ?? null,
}));

mock.module("../contacts/guardian-delivery-reader.js", () => ({
  peekCachedGuardianDelivery: (input?: { channelTypes?: string[] }) => {
    if (!input?.channelTypes) return mockGuardianDeliveries;
    return mockGuardianDeliveries.filter((g) =>
      input.channelTypes!.includes(g.channelType),
    );
  },
  // Warming the cache: reveals the pending guardian to the sync peek above,
  // mirroring how the production single-flight read populates the cache key.
  getGuardianDelivery: async (_input?: { channelTypes?: string[] }) => {
    if (pendingWarmDeliveries) {
      mockGuardianDeliveries = pendingWarmDeliveries;
      pendingWarmDeliveries = null;
    }
    return mockGuardianDeliveries;
  },
  guardianForChannel: (list: GuardianDeliveryStub[], channelType: string) =>
    list.find((g) => g.channelType === channelType && g.status === "active"),
  anyGuardian: (list: GuardianDeliveryStub[]) => list[0],
}));

// Import AFTER mocks so the module under test binds to the stubbed
// implementations.
import { getGuardianDelivery } from "../contacts/guardian-delivery-reader.js";
import type { TrustContext } from "../daemon/trust-context.js";
import {
  ensureGuardianPersonaFile,
  isGuardianPersonaCustomized,
  resolveGuardianPersona,
  resolveGuardianPersonaPath,
  resolveGuardianPersonaStrict,
  resolveUserSlug,
} from "../prompts/persona-resolver.js";

// ── Temp workspace scaffold ───────────────────────────────────────

let testRoot: string;

beforeAll(() => {
  testRoot = mkdtempSync(join(tmpdir(), "persona-resolver-test-"));
});

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

beforeEach(() => {
  // Fresh workspace per test, so filesystem state doesn't leak.
  mockWorkspaceDir = mkdtempSync(join(testRoot, "ws-"));
  mockGuardianDeliveries = [];
  mockContactsByAddress = {};
  pendingWarmDeliveries = null;
});

afterEach(() => {
  rmSync(mockWorkspaceDir, { recursive: true, force: true });
});

// ── resolveGuardianPersonaPath ─────────────────────────────────────

describe("resolveGuardianPersonaPath", () => {
  test("returns null when no guardian exists", () => {
    expect(resolveGuardianPersonaPath()).toBeNull();
  });

  test("returns absolute path when guardian has userFile set", () => {
    seedVellumGuardian("alice.md");

    const result = resolveGuardianPersonaPath();
    expect(result).toBe(join(mockWorkspaceDir, "users", "alice.md"));
  });

  test("falls back to default (null path) on a cold cache, but resolves the guardian after a warm", async () => {
    // Cold start: the guardian binding exists upstream but the sync cache is
    // empty, so a bare sync resolution misses it and falls back to default.
    pendingWarmDeliveries = [
      { channelType: "vellum", address: "vellum:self", status: "active" },
    ];
    mockContactsByAddress["vellum:vellum:self"] = { userFile: "alice.md" };

    expect(resolveGuardianPersonaPath()).toBeNull();

    // Async callers warm the vellum guardian-delivery cache before the sync
    // resolution; afterwards the guardian slug resolves instead of default.md.
    await getGuardianDelivery({ channelTypes: ["vellum"] });

    expect(resolveGuardianPersonaPath()).toBe(
      join(mockWorkspaceDir, "users", "alice.md"),
    );
  });
});

// ── ensureGuardianPersonaFile ──────────────────────────────────────

describe("ensureGuardianPersonaFile", () => {
  test("writes the template when the file is missing", () => {
    const userFile = "alice.md";
    const filePath = join(mockWorkspaceDir, "users", userFile);

    expect(existsSync(filePath)).toBe(false);

    ensureGuardianPersonaFile(userFile);

    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("# User Profile");
    expect(content).toContain("Preferred name/reference:");
    expect(content).toContain("Daily tools:");
    // Sanity check the comment-line prefix survives verbatim.
    expect(content.startsWith("_ Lines starting with _ are comments")).toBe(
      true,
    );
  });

  test("is a no-op when the file already exists (does not clobber)", () => {
    const userFile = "alice.md";
    const dir = join(mockWorkspaceDir, "users");
    const filePath = join(dir, userFile);
    const existingContent =
      "# Existing user notes\n\n- Likes sparkling water\n";

    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, existingContent, "utf-8");

    ensureGuardianPersonaFile(userFile);

    const content = readFileSync(filePath, "utf-8");
    expect(content).toBe(existingContent);
  });
});

// ── resolveGuardianPersonaStrict ───────────────────────────────────

describe("resolveGuardianPersonaStrict", () => {
  test("returns null when no guardian contact exists", () => {
    expect(resolveGuardianPersonaStrict()).toBeNull();
  });

  test("returns null when the guardian's own file is missing, even if default.md exists", () => {
    seedVellumGuardian("alice.md");

    // default.md is populated but alice.md is not on disk.
    const usersDir = join(mockWorkspaceDir, "users");
    mkdirSync(usersDir, { recursive: true });
    writeFileSync(
      join(usersDir, "default.md"),
      "- Preferred name/reference: DefaultName\n",
      "utf-8",
    );

    // Strict variant must not leak default.md content.
    expect(resolveGuardianPersonaStrict()).toBeNull();
    // Sanity: the non-strict variant DOES fall back to default.md, which
    // is the documented divergence these tests pin down.
    expect(resolveGuardianPersona()).toContain("DefaultName");
  });

  test("returns guardian file content when present", () => {
    seedVellumGuardian("alice.md");

    const usersDir = join(mockWorkspaceDir, "users");
    mkdirSync(usersDir, { recursive: true });
    writeFileSync(
      join(usersDir, "alice.md"),
      "- Preferred name/reference: Alice\n",
      "utf-8",
    );

    expect(resolveGuardianPersonaStrict()).toContain("Alice");
  });
});

// ── isGuardianPersonaCustomized ────────────────────────────────────

describe("isGuardianPersonaCustomized", () => {
  test("returns false when the file does not exist", () => {
    const filePath = join(mockWorkspaceDir, "users", "nobody.md");
    expect(isGuardianPersonaCustomized(filePath)).toBe(false);
  });

  test("returns false for the bare scaffold template (no user edits)", () => {
    const userFile = "alice.md";
    const filePath = join(mockWorkspaceDir, "users", userFile);

    // ensureGuardianPersonaFile writes the canonical template — the
    // exact bytes that "not customized" accepts.
    ensureGuardianPersonaFile(userFile);

    expect(isGuardianPersonaCustomized(filePath)).toBe(false);
  });

  test("returns false when the file contains only comment lines", () => {
    const userFile = "alice.md";
    const dir = join(mockWorkspaceDir, "users");
    const filePath = join(dir, userFile);

    mkdirSync(dir, { recursive: true });
    writeFileSync(
      filePath,
      "_ only comments here\n_ nothing meaningful\n",
      "utf-8",
    );

    expect(isGuardianPersonaCustomized(filePath)).toBe(false);
  });

  test("returns true when the file has user-authored content", () => {
    const userFile = "alice.md";
    const dir = join(mockWorkspaceDir, "users");
    const filePath = join(dir, userFile);

    mkdirSync(dir, { recursive: true });
    writeFileSync(
      filePath,
      "# My profile\n\n- Preferred name/reference: Real User\n",
      "utf-8",
    );

    expect(isGuardianPersonaCustomized(filePath)).toBe(true);
  });
});

// ── resolveUserSlug — background/scheduled guardian turns ──────────
//
// Background and scheduled turns carry a guardian trust context with no
// `requesterExternalUserId`. They must resolve the guardian's user file
// (parity with foreground guardian turns), not fall through to default.

describe("resolveUserSlug (guardian trust, no requester identity)", () => {
  test("guardian trust context without requesterExternalUserId resolves the guardian user file", () => {
    seedVellumGuardian("alice.md");

    const trustContext = {
      sourceChannel: "vellum",
      trustClass: "guardian",
    } as TrustContext;

    expect(resolveUserSlug(trustContext)).toBe("alice");
  });

  test("non-guardian trust context without requesterExternalUserId does not borrow the guardian persona", () => {
    seedVellumGuardian("alice.md");

    const trustContext = {
      sourceChannel: "vellum",
      trustClass: "trusted_contact",
    } as TrustContext;

    expect(resolveUserSlug(trustContext)).toBeNull();
  });

  test("guardian identity from the verdict keys the guardian user-file info read", () => {
    // The verdict-bound guardian is looked up by its address, not by the
    // most-recently-verified channel guardian, so a different channel guardian
    // does not shadow the verdict's binding.
    seedVellumGuardian("wrong-guardian.md");
    mockContactsByAddress["telegram:guardian-tg"] = {
      userFile: "alice.md",
    };

    const trustContext = {
      sourceChannel: "telegram",
      trustClass: "guardian",
      guardianExternalUserId: "guardian-tg",
    } as TrustContext;

    expect(resolveUserSlug(trustContext)).toBe("alice");
  });

  test("falls back to the channel guardian when the verdict carries no guardian identity", () => {
    seedVellumGuardian("alice.md");

    const trustContext = {
      sourceChannel: "vellum",
      trustClass: "guardian",
    } as TrustContext;

    expect(resolveUserSlug(trustContext)).toBe("alice");
  });
});

// ── resolveUserSlug — guardian turns WITH a requester identity ─────
//
// A foreground guardian turn (e.g. the local desktop app after hatch) carries
// both a `requesterExternalUserId` (the principal id) and a
// `guardianExternalUserId`. The requester lookup can find the guardian's own
// contact row whose `userFile` column is still null — the normal post-hatch
// state, since onboarding writes users/guardian.md on disk but not the column.
// That null must not strand the read on users/default.md: it has to fall
// through to the guardian file the onboarding profile was written to.

describe("resolveUserSlug (guardian trust WITH requester identity)", () => {
  test("null-userFile guardian contact falls through to the guardian file, not default", () => {
    // Guardian contact exists but has no explicit userFile (post-hatch state).
    seedVellumGuardian(null);
    // The requester principal id resolves to that same null-userFile contact.
    mockContactsByAddress["vellum:principal-123"] = { userFile: null };

    const trustContext = {
      sourceChannel: "vellum",
      trustClass: "guardian",
      requesterExternalUserId: "principal-123",
      guardianExternalUserId: "vellum:self",
    } as TrustContext;

    expect(resolveUserSlug(trustContext)).toBe("guardian");
  });

  test("an explicit requester userFile still wins over the guardian fallback", () => {
    seedVellumGuardian(null);
    mockContactsByAddress["vellum:principal-123"] = { userFile: "alice.md" };

    const trustContext = {
      sourceChannel: "vellum",
      trustClass: "guardian",
      requesterExternalUserId: "principal-123",
      guardianExternalUserId: "vellum:self",
    } as TrustContext;

    expect(resolveUserSlug(trustContext)).toBe("alice");
  });

  test("non-guardian turn with a null-userFile contact does not borrow the guardian persona", () => {
    seedVellumGuardian(null);
    mockContactsByAddress["vellum:principal-123"] = { userFile: null };

    const trustContext = {
      sourceChannel: "vellum",
      trustClass: "trusted_contact",
      requesterExternalUserId: "principal-123",
      guardianExternalUserId: "vellum:self",
    } as TrustContext;

    expect(resolveUserSlug(trustContext)).toBeNull();
  });
});
