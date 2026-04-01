import { describe, expect, test } from "bun:test";

import {
  evaluateRemoteSkillInstall,
  filterInstallableRemoteSkills,
  type RemoteSkillPolicy,
} from "../skills/remote-skill-policy.js";

describe("remote skill policy — skillssh moderation", () => {
  const policy: RemoteSkillPolicy = {
    blockSuspicious: true,
    blockMalware: true,
    maxSkillsShRisk: "medium",
  };

  test("suspicious skills are excluded from installable list", () => {
    const candidates = [
      {
        provider: "clawhub" as const,
        slug: "safe-skill",
        moderation: { isSuspicious: false, isMalwareBlocked: false },
      },
      {
        provider: "clawhub" as const,
        slug: "suspicious-skill",
        moderation: { isSuspicious: true, isMalwareBlocked: false },
      },
    ];

    const installable = filterInstallableRemoteSkills(candidates, policy);
    expect(installable.map((skill) => skill.slug)).toEqual(["safe-skill"]);
  });

  test("suspicious skills are not installable when installation is attempted", () => {
    const decision = evaluateRemoteSkillInstall(
      {
        provider: "clawhub",
        slug: "suspicious-skill",
        moderation: { isSuspicious: true, isMalwareBlocked: false },
      },
      policy,
    );

    expect(decision).toEqual({ ok: false, reason: "clawhub_suspicious" });
  });

  test("malware-blocked skills are excluded from installable list and blocked on install", () => {
    const candidates = [
      {
        provider: "clawhub" as const,
        slug: "malware-skill",
        moderation: { isSuspicious: false, isMalwareBlocked: true },
      },
    ];

    expect(filterInstallableRemoteSkills(candidates, policy)).toEqual([]);

    const decision = evaluateRemoteSkillInstall(candidates[0], policy);
    expect(decision).toEqual({ ok: false, reason: "clawhub_malware_blocked" });
  });

  test("skill with undefined moderation is blocked (fail-closed)", () => {
    const decision = evaluateRemoteSkillInstall(
      {
        provider: "clawhub",
        slug: "no-moderation-skill",
        moderation: undefined,
      },
      policy,
    );

    expect(decision).toEqual({
      ok: false,
      reason: "clawhub_moderation_missing",
    });
  });

  test("skill with null moderation is blocked (fail-closed)", () => {
    const decision = evaluateRemoteSkillInstall(
      {
        provider: "clawhub",
        slug: "null-moderation-skill",
        moderation: null,
      },
      policy,
    );

    expect(decision).toEqual({
      ok: false,
      reason: "clawhub_moderation_missing",
    });
  });

  test("skill without moderation property is blocked (fail-closed)", () => {
    const decision = evaluateRemoteSkillInstall(
      {
        provider: "clawhub",
        slug: "missing-moderation-skill",
      },
      policy,
    );

    expect(decision).toEqual({
      ok: false,
      reason: "clawhub_moderation_missing",
    });
  });

  test("skills with missing moderation are excluded from installable list", () => {
    const candidates = [
      {
        provider: "clawhub" as const,
        slug: "safe-skill",
        moderation: { isSuspicious: false, isMalwareBlocked: false },
      },
      {
        provider: "clawhub" as const,
        slug: "no-moderation-skill",
      },
    ];

    const installable = filterInstallableRemoteSkills(candidates, policy);
    expect(installable.map((skill) => skill.slug)).toEqual(["safe-skill"]);
  });
});

describe("remote skill policy — skills.sh", () => {
  const policy: RemoteSkillPolicy = {
    blockSuspicious: true,
    blockMalware: true,
    maxSkillsShRisk: "medium",
  };

  test("high-risk skills are excluded from installable list", () => {
    const candidates = [
      {
        provider: "skillssh" as const,
        slug: "safe-skill",
        audit: { risk: "low" as const },
      },
      {
        provider: "skillssh" as const,
        slug: "suspicious-skill",
        audit: { risk: "high" as const },
      },
    ];

    const installable = filterInstallableRemoteSkills(candidates, policy);
    expect(installable.map((skill) => skill.slug)).toEqual(["safe-skill"]);
  });

  test("high-risk skills are not installable when installation is attempted", () => {
    const decision = evaluateRemoteSkillInstall(
      {
        provider: "skillssh",
        slug: "suspicious-skill",
        audit: { risk: "high" },
      },
      policy,
    );

    expect(decision).toEqual({
      ok: false,
      reason: "skillssh_risk_exceeds_threshold",
    });
  });

  test("unknown risk is treated as suspicious and blocked by default", () => {
    const decision = evaluateRemoteSkillInstall(
      {
        provider: "skillssh",
        slug: "unknown-risk-skill",
        audit: { risk: "unknown" },
      },
      policy,
    );

    expect(decision).toEqual({
      ok: false,
      reason: "skillssh_risk_exceeds_threshold",
    });
  });

  test("risk threshold is enforced even when blockSuspicious is false", () => {
    const permissivePolicy: RemoteSkillPolicy = {
      blockSuspicious: false,
      blockMalware: false,
      maxSkillsShRisk: "medium",
    };

    const decision = evaluateRemoteSkillInstall(
      {
        provider: "skillssh",
        slug: "high-risk-skill",
        audit: { risk: "high" },
      },
      permissivePolicy,
    );

    expect(decision).toEqual({
      ok: false,
      reason: "skillssh_risk_exceeds_threshold",
    });
  });

  test("prototype property risk label is treated as unknown and blocked", () => {
    const decision = evaluateRemoteSkillInstall(
      {
        provider: "skillssh",
        slug: "proto-risk-skill",
        // "toString" exists on Object.prototype — must not be treated as a known risk label
        audit: { risk: "toString" as never },
      },
      policy,
    );

    expect(decision).toEqual({
      ok: false,
      reason: "skillssh_risk_exceeds_threshold",
    });
  });

  test("unrecognized risk string is coerced to unknown and blocked", () => {
    const decision = evaluateRemoteSkillInstall(
      {
        provider: "skillssh",
        slug: "bogus-risk-skill",
        // Cast to bypass type checking — simulates a provider returning a novel risk label
        audit: { risk: "super-duper-risky" as never },
      },
      policy,
    );

    expect(decision).toEqual({
      ok: false,
      reason: "skillssh_risk_exceeds_threshold",
    });
  });
});
