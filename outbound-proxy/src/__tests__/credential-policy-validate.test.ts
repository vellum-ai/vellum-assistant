import { describe, expect, test } from "bun:test";

import type { CredentialPolicyInput } from "../types.js";
import {
  createStrictDefaultPolicy,
  toPolicyFromInput,
  validatePolicyInput,
} from "../credentials/policy-validate.js";

describe("validatePolicyInput", () => {
  test("valid input with all fields", () => {
    const input: CredentialPolicyInput = {
      allowed_tools: ["browser_fill_credential"],
      allowed_domains: ["example.com", "login.example.com"],
      usage_description: "Login to example.com",
    };
    const result = validatePolicyInput(input);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("valid input with no fields (all optional)", () => {
    const result = validatePolicyInput({});
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("valid input with only allowed_tools", () => {
    const result = validatePolicyInput({ allowed_tools: ["bash"] });
    expect(result.valid).toBe(true);
  });

  test("valid input with only allowed_domains", () => {
    const result = validatePolicyInput({ allowed_domains: ["example.com"] });
    expect(result.valid).toBe(true);
  });

  test("invalid: allowed_tools not an array", () => {
    const result = validatePolicyInput({
      allowed_tools: "browser_fill_credential" as unknown as string[],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "allowed_tools must be an array of strings",
    );
  });

  test("invalid: allowed_tools contains empty string", () => {
    const result = validatePolicyInput({
      allowed_tools: ["browser_fill_credential", ""],
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("allowed_tools[1]");
  });

  test("invalid: allowed_tools contains non-string", () => {
    const result = validatePolicyInput({
      allowed_tools: ["browser_fill_credential", 42 as unknown as string],
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("allowed_tools[1]");
  });

  test("invalid: host_bash rejected from allowed_tools", () => {
    /**
     * Credentials must not be accessible from host tools that execute
     * directly on the user's machine — only sandboxed tools are allowed.
     */

    // GIVEN a policy input that includes host_bash
    const input: CredentialPolicyInput = {
      allowed_tools: ["host_bash"],
    };

    // WHEN we validate the input
    const result = validatePolicyInput(input);

    // THEN validation fails with a message suggesting the sandboxed alternative
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("host_bash");
    expect(result.errors[0]).toContain("bash");
  });

  test("invalid: host_file_read rejected from allowed_tools", () => {
    /**
     * All host_* tools should be blocked from credential allowed_tools.
     */

    // GIVEN a policy input that includes host_file_read
    const input: CredentialPolicyInput = {
      allowed_tools: ["host_file_read"],
    };

    // WHEN we validate the input
    const result = validatePolicyInput(input);

    // THEN validation fails and suggests file_read instead
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("host_file_read");
    expect(result.errors[0]).toContain("file_read");
  });

  test("invalid: host_file_write rejected from allowed_tools", () => {
    /**
     * host_file_write should be blocked and suggest file_write.
     */

    // GIVEN a policy input that includes host_file_write
    const input: CredentialPolicyInput = {
      allowed_tools: ["host_file_write"],
    };

    // WHEN we validate the input
    const result = validatePolicyInput(input);

    // THEN validation fails and suggests file_write instead
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("host_file_write");
    expect(result.errors[0]).toContain("file_write");
  });

  test("invalid: host_file_edit rejected from allowed_tools", () => {
    /**
     * host_file_edit should be blocked and suggest file_edit.
     */

    // GIVEN a policy input that includes host_file_edit
    const input: CredentialPolicyInput = {
      allowed_tools: ["host_file_edit"],
    };

    // WHEN we validate the input
    const result = validatePolicyInput(input);

    // THEN validation fails and suggests file_edit instead
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("host_file_edit");
    expect(result.errors[0]).toContain("file_edit");
  });

  test("invalid: host tool mixed with valid tools still rejected", () => {
    /**
     * Even when mixed with valid tools, host tools should cause validation failure.
     */

    // GIVEN a policy input that mixes valid and host tools
    const input: CredentialPolicyInput = {
      allowed_tools: ["browser_fill_credential", "host_bash", "bash"],
    };

    // WHEN we validate the input
    const result = validatePolicyInput(input);

    // THEN validation fails for the host_bash entry
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("allowed_tools[1]");
    expect(result.errors[0]).toContain("host_bash");
  });

  test("invalid: allowed_domains not an array", () => {
    const result = validatePolicyInput({
      allowed_domains: "example.com" as unknown as string[],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "allowed_domains must be an array of strings",
    );
  });

  test("invalid: allowed_domains contains empty string", () => {
    const result = validatePolicyInput({
      allowed_domains: ["example.com", "  "],
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("allowed_domains[1]");
  });

  test("invalid: usage_description not a string", () => {
    const result = validatePolicyInput({
      usage_description: 123 as unknown as string,
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("usage_description must be a string");
  });

  test("multiple errors reported at once", () => {
    const result = validatePolicyInput({
      allowed_tools: "bad" as unknown as string[],
      allowed_domains: 42 as unknown as string[],
      usage_description: true as unknown as string,
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(3);
  });
});

describe("toPolicyFromInput", () => {
  test("converts full input to policy", () => {
    const policy = toPolicyFromInput({
      allowed_tools: ["browser_fill_credential"],
      allowed_domains: ["example.com"],
      usage_description: "Login credentials",
    });
    expect(policy.allowedTools).toEqual(["browser_fill_credential"]);
    expect(policy.allowedDomains).toEqual(["example.com"]);
    expect(policy.usageDescription).toBe("Login credentials");
  });

  test("defaults missing arrays to empty (deny all)", () => {
    const policy = toPolicyFromInput({});
    expect(policy.allowedTools).toEqual([]);
    expect(policy.allowedDomains).toEqual([]);
    expect(policy.usageDescription).toBeUndefined();
  });

  test("preserves provided empty arrays", () => {
    const policy = toPolicyFromInput({
      allowed_tools: [],
      allowed_domains: [],
    });
    expect(policy.allowedTools).toEqual([]);
    expect(policy.allowedDomains).toEqual([]);
  });
});

describe("createStrictDefaultPolicy", () => {
  test("returns deny-all policy", () => {
    const policy = createStrictDefaultPolicy();
    expect(policy.allowedTools).toEqual([]);
    expect(policy.allowedDomains).toEqual([]);
    expect(policy.usageDescription).toBeUndefined();
    expect(policy.createdByFlow).toBeUndefined();
  });
});
