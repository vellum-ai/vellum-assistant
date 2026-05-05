import { describe, expect, test } from "bun:test";

import type { DiskPressureStatus } from "../daemon/disk-pressure-guard.js";
import {
  classifyDiskPressureTurnPolicy,
  type DiskPressureTurnMetadata,
  type DiskPressureTurnPolicyDecision,
} from "../daemon/disk-pressure-policy.js";

const LOCKED_STATUS = {
  enabled: true,
  state: "critical",
  locked: true,
  acknowledged: true,
  overrideActive: false,
  effectivelyLocked: true,
  lockId: "disk-pressure-test",
  usagePercent: 98,
  thresholdPercent: 95,
  path: "/",
  lastCheckedAt: "2026-05-05T00:00:00.000Z",
  blockedCapabilities: ["agent-turns", "background-work", "remote-ingress"],
  error: null,
} satisfies DiskPressureStatus;

function status(
  overrides: Partial<DiskPressureStatus> = {},
): DiskPressureStatus {
  return {
    ...LOCKED_STATUS,
    ...overrides,
    blockedCapabilities:
      overrides.blockedCapabilities ?? LOCKED_STATUS.blockedCapabilities,
  };
}

const localOwnerTurn = {
  conversationType: "standard",
  callSite: "mainAgent",
  isInteractive: true,
  sourceChannel: "vellum",
  sourceInterface: "macos",
} satisfies DiskPressureTurnMetadata;

const guardianTurn = {
  ...localOwnerTurn,
  sourceChannel: "telegram",
  sourceInterface: "telegram",
  trustContext: {
    sourceChannel: "telegram",
    trustClass: "guardian",
  },
} satisfies DiskPressureTurnMetadata;

describe("classifyDiskPressureTurnPolicy", () => {
  test.each([
    {
      name: "flag disabled allows normal turns",
      status: status({
        enabled: false,
        state: "disabled",
        locked: false,
        effectivelyLocked: false,
        blockedCapabilities: [],
      }),
      metadata: guardianTurn,
      expected: { action: "allow-normal" },
    },
    {
      name: "unlocked allows normal turns",
      status: status({ locked: false, effectivelyLocked: false }),
      metadata: guardianTurn,
      expected: { action: "allow-normal" },
    },
    {
      name: "override active allows normal turns",
      status: status({ overrideActive: true, effectivelyLocked: false }),
      metadata: guardianTurn,
      expected: { action: "allow-normal" },
    },
    {
      name: "locked acknowledged local owner without trust enters cleanup mode",
      status: status({ acknowledged: true }),
      metadata: localOwnerTurn,
      expected: { action: "allow-cleanup-mode", reason: "local-owner" },
    },
    {
      name: "locked unacknowledged local owner without trust enters cleanup mode",
      status: status({ acknowledged: false }),
      metadata: localOwnerTurn,
      expected: { action: "allow-cleanup-mode", reason: "local-owner" },
    },
    {
      name: "locked guardian enters cleanup mode",
      status: status(),
      metadata: guardianTurn,
      expected: { action: "allow-cleanup-mode", reason: "guardian" },
    },
    {
      name: "trusted contact is blocked",
      status: status(),
      metadata: {
        ...guardianTurn,
        trustContext: {
          sourceChannel: "telegram",
          trustClass: "trusted_contact",
        },
      },
      expected: { action: "block", reason: "trusted-contact" },
    },
    {
      name: "non-guardian contact is blocked",
      status: status(),
      metadata: {
        ...guardianTurn,
        trustContext: {
          sourceChannel: "telegram",
          trustClass: "non_guardian",
        },
      },
      expected: { action: "block", reason: "non-guardian" },
    },
    {
      name: "future non-guardian trust class is blocked",
      status: status(),
      metadata: {
        ...guardianTurn,
        trustContext: {
          sourceChannel: "telegram",
          trustClass: "member",
        },
      },
      expected: { action: "block", reason: "non-guardian" },
    },
    {
      name: "unknown remote sender is blocked",
      status: status(),
      metadata: {
        ...guardianTurn,
        trustContext: {
          sourceChannel: "telegram",
          trustClass: "unknown",
        },
      },
      expected: { action: "block", reason: "unknown-remote" },
    },
    {
      name: "remote turn without trust context is blocked",
      status: status(),
      metadata: {
        conversationType: "standard",
        callSite: "mainAgent",
        isInteractive: true,
        sourceChannel: "telegram",
        sourceInterface: "telegram",
      },
      expected: { action: "block", reason: "unknown-remote" },
    },
    {
      name: "background conversation is blocked",
      status: status(),
      metadata: {
        ...guardianTurn,
        conversationType: "background",
      },
      expected: { action: "block", reason: "background" },
    },
    {
      name: "scheduled background group is blocked",
      status: status(),
      metadata: {
        ...guardianTurn,
        conversationGroupId: "system:scheduled",
      },
      expected: { action: "block", reason: "background" },
    },
    {
      name: "background source is blocked",
      status: status(),
      metadata: {
        ...guardianTurn,
        conversationSource: "heartbeat",
      },
      expected: { action: "block", reason: "background" },
    },
    {
      name: "non-main call site is blocked",
      status: status(),
      metadata: {
        ...guardianTurn,
        callSite: "memoryConsolidation",
      },
      expected: { action: "block", reason: "background" },
    },
    {
      name: "direct wake metadata is blocked",
      status: status(),
      metadata: {
        ...guardianTurn,
        isDirectWake: true,
      },
      expected: { action: "block", reason: "background" },
    },
    {
      name: "direct wake source is blocked",
      status: status(),
      metadata: {
        ...guardianTurn,
        conversationSource: "direct",
      },
      expected: { action: "block", reason: "background" },
    },
    {
      name: "local-owner background turn without direct wake is blocked",
      status: status(),
      metadata: {
        ...localOwnerTurn,
        conversationType: "background",
        conversationSource: "heartbeat",
      },
      expected: { action: "block", reason: "background" },
    },
    {
      name: "explicit local-owner direct wake can enter cleanup mode",
      status: status(),
      metadata: {
        ...localOwnerTurn,
        conversationSource: "local-cleanup",
        isDirectWake: true,
      },
      expected: { action: "allow-cleanup-mode", reason: "local-owner" },
    },
  ] satisfies Array<{
    name: string;
    status: DiskPressureStatus;
    metadata: DiskPressureTurnMetadata;
    expected: DiskPressureTurnPolicyDecision;
  }>)("$name", ({ status, metadata, expected }) => {
    expect(classifyDiskPressureTurnPolicy(status, metadata)).toEqual(expected);
  });
});
