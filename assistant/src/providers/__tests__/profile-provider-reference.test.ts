import { describe, expect, test } from "bun:test";

import {
  connectionNameFromProfileProviderReference,
  profileProviderForConnection,
} from "../profile-provider-reference.js";

describe("profile provider references", () => {
  test("keeps ordinary entry names readable", () => {
    expect(profileProviderForConnection("anthropic-work")).toBe(
      "anthropic-work",
    );
    expect(
      connectionNameFromProfileProviderReference("anthropic-work"),
    ).toBeNull();
  });

  test("namespaces exact rows that collide with provider ids", () => {
    const reference = profileProviderForConnection("anthropic");
    expect(reference).toBe("connection:anthropic");
    expect(connectionNameFromProfileProviderReference(reference)).toBe(
      "anthropic",
    );
  });

  test("escapes row names that collide with the reference syntax", () => {
    const reference = profileProviderForConnection("connection:anthropic");
    expect(reference).toBe("connection:connection%3Aanthropic");
    expect(connectionNameFromProfileProviderReference(reference)).toBe(
      "connection:anthropic",
    );
  });

  test("rejects empty and malformed references", () => {
    expect(
      connectionNameFromProfileProviderReference("connection:"),
    ).toBeNull();
    expect(
      connectionNameFromProfileProviderReference("connection:%not-uri"),
    ).toBeNull();
  });
});
