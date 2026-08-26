import { describe, expect, test } from "bun:test";

import { initGatewayDb, resetGatewayDb } from "../db/connection.js";
import { TrustRuleStore } from "../db/trust-rule-store.js";
import { initTrustRuleCache, resetTrustRuleCache } from "./trust-rule-cache.js";
import { powerShellRiskClassifier } from "./powershell-risk-classifier.js";
import "../__tests__/test-preload.js";

describe("PowerShellRiskClassifier", () => {
  test("classifies read-only cmdlets as low risk", async () => {
    const result = await powerShellRiskClassifier.classify(
      "Get-ChildItem C:\\Users",
    );

    expect(result.riskLevel).toBe("low");
    expect(result.actionKeys).toContain("action:get-childitem");
  });

  test("classifies destructive cmdlets and aliases as high risk", async () => {
    const cmdlet = await powerShellRiskClassifier.classify(
      "Remove-Item -Recurse C:\\Temp\\data",
    );
    const alias = await powerShellRiskClassifier.classify(
      "rm -Recurse C:\\Temp\\data",
    );

    expect(cmdlet.riskLevel).toBe("high");
    expect(alias.riskLevel).toBe("high");
  });

  test("classifies dynamic PowerShell execution as high risk", async () => {
    const result = await powerShellRiskClassifier.classify(
      "Invoke-Expression $payload",
    );

    expect(result.riskLevel).toBe("high");
    expect(result.dangerousPatterns).not.toHaveLength(0);
  });

  test("classifies pipelines using PowerShell command boundaries", async () => {
    const result = await powerShellRiskClassifier.classify(
      "Get-Process | Select-Object Name",
    );

    expect(result.riskLevel).toBe("low");
    expect(result.isComplexSyntax).toBe(true);
    expect(result.actionKeys).toEqual([
      "action:get-process",
      "action:select-object",
    ]);
  });

  test("uses the native command registry for external programs", async () => {
    const result = await powerShellRiskClassifier.classify("git push --force");

    expect(result.riskLevel).toBe("high");
  });

  test("extracts Windows paths for directory-scoped trust rules", async () => {
    const result = await powerShellRiskClassifier.classify(
      "Remove-Item -Path C:\\Temp\\data.txt",
    );

    expect(result.resolvedPaths).toEqual(["C:\\Temp\\data.txt"]);
    expect(result.directoryScopeOptions).toEqual([
      { scope: "C:\\Temp\\*", label: "In Temp/" },
      { scope: "everywhere", label: "Everywhere" },
    ]);
  });

  test("keeps formatting cmdlets low risk", async () => {
    const result = await powerShellRiskClassifier.classify(
      "Get-Process | Format-Table Name",
    );

    expect(result.riskLevel).toBe("low");
  });

  test("distinguishes disk formatting from output formatting", async () => {
    const result = await powerShellRiskClassifier.classify("format D:");

    expect(result.riskLevel).toBe("high");
  });

  test("classifies direct script invocation as high risk", async () => {
    const result = await powerShellRiskClassifier.classify(
      ".\\scripts\\setup.ps1",
    );

    expect(result.riskLevel).toBe("high");
  });

  test("classifies Start-Process as high risk", async () => {
    const result = await powerShellRiskClassifier.classify(
      "Start-Process C:\\Temp\\payload.exe",
    );

    expect(result.riskLevel).toBe("high");
  });

  test("classifies commands on assignment right-hand sides", async () => {
    const result = await powerShellRiskClassifier.classify(
      "$result = Remove-Item -Recurse C:\\Temp\\data",
    );

    expect(result.riskLevel).toBe("high");
    expect(result.actionKeys).toContain("action:remove-item");
  });

  test("classifies commands after typed assignment targets", async () => {
    const result = await powerShellRiskClassifier.classify(
      "[ValidateNotNull()][string]$result = Remove-Item -Recurse C:\\Temp\\data",
    );

    expect(result.riskLevel).toBe("high");
    expect(result.actionKeys).toContain("action:remove-item");
  });

  test("classifies direct .NET member invocation as high risk", async () => {
    const result = await powerShellRiskClassifier.classify(
      "[System.IO.File]::Delete('C:\\Temp\\data.txt')",
    );

    expect(result.riskLevel).toBe("high");
    expect(result.dangerousPatterns).not.toHaveLength(0);
  });

  test("classifies output redirection as state-changing", async () => {
    const result = await powerShellRiskClassifier.classify(
      "Get-Content C:\\Temp\\source.txt > C:\\Temp\\destination.txt",
    );

    expect(result.riskLevel).toBe("medium");
    expect(result.isComplexSyntax).toBe(true);
  });

  test("classifies adjacent call operators as high risk", async () => {
    const quoted = await powerShellRiskClassifier.classify(
      "&'Remove-Item' -Recurse C:\\Temp\\data",
    );
    const expression = await powerShellRiskClassifier.classify(
      "&(Get-Command Remove-Item) -Recurse C:\\Temp\\data",
    );

    expect(quoted.riskLevel).toBe("high");
    expect(expression.riskLevel).toBe("high");
    expect(quoted.opaqueConstructs).toBe(true);
  });

  test("does not treat escaped or logical ampersands as call operators", async () => {
    const escaped = await powerShellRiskClassifier.classify("Write-Output `&");
    const logical = await powerShellRiskClassifier.classify(
      "Get-Process && Get-Service",
    );

    expect(escaped.opaqueConstructs).toBe(false);
    expect(logical.opaqueConstructs).toBe(false);
  });

  test("matches normalized action trust rules", async () => {
    resetGatewayDb();
    await initGatewayDb();
    const store = new TrustRuleStore();
    store.create({
      tool: "host_bash",
      pattern: "action:remove-item",
      risk: "low",
      description: "Allowed remove-item command",
    });
    initTrustRuleCache(store);

    try {
      const result = await powerShellRiskClassifier.classify(
        "Remove-Item C:\\Temp\\data.txt",
      );

      expect(result.riskLevel).toBe("low");
      expect(result.matchType).toBe("user_rule");
    } finally {
      resetTrustRuleCache();
      resetGatewayDb();
    }
  });
});
