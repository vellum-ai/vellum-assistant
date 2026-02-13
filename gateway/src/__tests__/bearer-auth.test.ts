import { describe, test, expect } from "bun:test";
import { validateBearerToken } from "../http/auth/bearer.js";

const TOKEN = "test-secret-token";

describe("validateBearerToken", () => {
  test("missing header returns unauthorized", () => {
    const result = validateBearerToken(null, TOKEN);
    expect(result.authorized).toBe(false);
    if (!result.authorized) {
      expect(result.reason).toContain("Missing");
    }
  });

  test("wrong scheme returns unauthorized", () => {
    const result = validateBearerToken("Basic abc123", TOKEN);
    expect(result.authorized).toBe(false);
    if (!result.authorized) {
      expect(result.reason).toContain("scheme");
    }
  });

  test("wrong token returns unauthorized", () => {
    const result = validateBearerToken("Bearer wrong-token", TOKEN);
    expect(result.authorized).toBe(false);
    if (!result.authorized) {
      expect(result.reason).toContain("Invalid bearer token");
    }
  });

  test("exact token returns authorized", () => {
    const result = validateBearerToken(`Bearer ${TOKEN}`, TOKEN);
    expect(result.authorized).toBe(true);
  });

  test("empty bearer value returns unauthorized", () => {
    const result = validateBearerToken("Bearer ", TOKEN);
    expect(result.authorized).toBe(false);
  });
});
