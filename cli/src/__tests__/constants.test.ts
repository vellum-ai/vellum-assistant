import { describe, test, expect } from "bun:test";
import {
  FIREWALL_TAG,
  GATEWAY_PORT,
  VALID_REMOTE_HOSTS,
  VALID_SPECIES,
  SPECIES_CONFIG,
} from "../lib/constants.js";

describe("constants", () => {
  test("FIREWALL_TAG is a non-empty string", () => {
    expect(typeof FIREWALL_TAG).toBe("string");
    expect(FIREWALL_TAG.length).toBeGreaterThan(0);
  });

  test("GATEWAY_PORT is a valid port number", () => {
    expect(typeof GATEWAY_PORT).toBe("number");
    expect(GATEWAY_PORT).toBeGreaterThan(0);
    expect(GATEWAY_PORT).toBeLessThan(65536);
  });

  test("VALID_REMOTE_HOSTS includes expected hosts", () => {
    expect(VALID_REMOTE_HOSTS).toContain("local");
    expect(VALID_REMOTE_HOSTS).toContain("gcp");
    expect(VALID_REMOTE_HOSTS).toContain("aws");
    expect(VALID_REMOTE_HOSTS).toContain("docker");
    expect(VALID_REMOTE_HOSTS).toContain("smolvm");
    expect(VALID_REMOTE_HOSTS).toContain("custom");
  });

  test("VALID_SPECIES includes expected species", () => {
    expect(VALID_SPECIES).toContain("openclaw");
    expect(VALID_SPECIES).toContain("vellum");
  });

  test("SPECIES_CONFIG has entries for all valid species", () => {
    for (const species of VALID_SPECIES) {
      const config = SPECIES_CONFIG[species];
      expect(config).toBeDefined();
      expect(typeof config.color).toBe("string");
      expect(Array.isArray(config.art)).toBe(true);
      expect(config.art.length).toBeGreaterThan(0);
      expect(typeof config.hatchedEmoji).toBe("string");
      expect(Array.isArray(config.waitingMessages)).toBe(true);
      expect(config.waitingMessages.length).toBeGreaterThan(0);
      expect(Array.isArray(config.runningMessages)).toBe(true);
      expect(config.runningMessages.length).toBeGreaterThan(0);
    }
  });
});
