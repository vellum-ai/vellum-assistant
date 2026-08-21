import { describe, expect, test } from "bun:test";

import { powerShellRiskClassifier } from "./powershell-risk-classifier.js";

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

  test("classifies commands on assignment right-hand sides", async () => {
    const result = await powerShellRiskClassifier.classify(
      "$result = Remove-Item -Recurse C:\\Temp\\data",
    );

    expect(result.riskLevel).toBe("high");
    expect(result.actionKeys).toContain("action:remove-item");
  });
});
