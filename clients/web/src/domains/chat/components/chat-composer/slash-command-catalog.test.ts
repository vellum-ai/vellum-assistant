import { describe, expect, test } from "bun:test";

import {
  isLocalMetaCommand,
  parseDoctorCommand,
} from "@/domains/chat/components/chat-composer/slash-command-catalog";

describe("isLocalMetaCommand", () => {
  test("recognises the local meta commands", () => {
    for (const cmd of ["/clean", "/status", "/commands", "/models"]) {
      expect(isLocalMetaCommand(cmd)).toBe(true);
    }
  });

  test("tolerates surrounding whitespace, trailing args, and case", () => {
    expect(isLocalMetaCommand("  /clean  ")).toBe(true);
    expect(isLocalMetaCommand("/clean foo")).toBe(true);
    expect(isLocalMetaCommand("/CLEAN")).toBe(true);
  });

  test("excludes turn commands and lookalikes", () => {
    // /compact runs the LLM (a real turn); /model switches the profile (a
    // side-effecting command); the rest are non-commands or prefixes.
    for (const cmd of [
      "/compact",
      "/btw",
      "/model",
      "/cleanup",
      "/clean-context",
      "hello",
      "/",
    ]) {
      expect(isLocalMetaCommand(cmd)).toBe(false);
    }
  });
});

describe("parseDoctorCommand", () => {
  test("extracts the trailing first message", () => {
    // GIVEN a /doctor command carrying a first message
    // WHEN parsed
    // THEN the trimmed message is returned
    expect(parseDoctorCommand("/doctor fix my profiles to save me money")).toBe(
      "fix my profiles to save me money",
    );
  });

  test("returns an empty string for a bare command and tolerates whitespace/case", () => {
    // GIVEN /doctor sent alone (with surrounding or trailing whitespace, any case)
    // WHEN parsed
    // THEN the message is empty (navigate only, no first message)
    for (const cmd of ["/doctor", "  /doctor  ", "/doctor   ", "/DOCTOR"]) {
      expect(parseDoctorCommand(cmd)).toBe("");
    }
  });

  test("preserves internal whitespace and multi-line messages", () => {
    // GIVEN a first message with internal and multi-line whitespace
    // WHEN parsed
    // THEN only the surrounding whitespace is trimmed
    expect(parseDoctorCommand("/doctor  line one\nline two  ")).toBe(
      "line one\nline two",
    );
  });

  test("returns null for non-doctor input and lookalikes", () => {
    // GIVEN input that is not a /doctor command
    // WHEN parsed
    // THEN null is returned so the send path continues normally
    for (const input of [
      "/doctors help",
      "/doctorfix",
      "doctor fix",
      "hello",
      "/status",
      "/",
    ]) {
      expect(parseDoctorCommand(input)).toBeNull();
    }
  });
});
