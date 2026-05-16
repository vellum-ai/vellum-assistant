import { describe, expect, test } from "bun:test";

import { buildAgentCard } from "../agent-card.js";

describe("buildAgentCard", () => {
  const BASE_PARAMS = {
    assistantName: "Alice",
    baseUrl: "https://example.com",
  };

  test("includes all required top-level fields", () => {
    const card = buildAgentCard(BASE_PARAMS);

    expect(card.name).toBe("Alice");
    expect(card.description).toBeDefined();
    expect(card.version).toBe("1.0.0");
    expect(card.supported_interfaces).toBeDefined();
    expect(card.capabilities).toBeDefined();
    expect(card.default_input_modes).toBeDefined();
    expect(card.default_output_modes).toBeDefined();
    expect(card.skills).toBeDefined();
  });

  test("interface URL is baseUrl + /a2a/message:send", () => {
    const card = buildAgentCard(BASE_PARAMS);

    expect(card.supported_interfaces).toHaveLength(1);
    expect(card.supported_interfaces[0].url).toBe(
      "https://example.com/a2a/message:send",
    );
    expect(card.supported_interfaces[0].protocol_binding).toBe("JSONRPC");
    expect(card.supported_interfaces[0].protocol_version).toBe("1.0");
  });

  test("push_notifications capability is true", () => {
    const card = buildAgentCard(BASE_PARAMS);

    expect(card.capabilities.push_notifications).toBe(true);
  });

  test("streaming capability is false", () => {
    const card = buildAgentCard(BASE_PARAMS);

    expect(card.capabilities.streaming).toBe(false);
  });

  test("extended_agent_card capability is false", () => {
    const card = buildAgentCard(BASE_PARAMS);

    expect(card.capabilities.extended_agent_card).toBe(false);
  });

  test("defaults description when omitted", () => {
    const card = buildAgentCard(BASE_PARAMS);

    expect(card.description).toBe("Alice — a Vellum AI assistant");
  });

  test("uses explicit description when provided", () => {
    const card = buildAgentCard({
      ...BASE_PARAMS,
      assistantDescription: "A specialized research assistant",
    });

    expect(card.description).toBe("A specialized research assistant");
  });

  test("advertises text/plain as default input and output mode", () => {
    const card = buildAgentCard(BASE_PARAMS);

    expect(card.default_input_modes).toEqual(["text/plain"]);
    expect(card.default_output_modes).toEqual(["text/plain"]);
  });

  test("includes a conversation skill", () => {
    const card = buildAgentCard(BASE_PARAMS);

    expect(card.skills).toHaveLength(1);
    expect(card.skills[0]).toEqual({
      id: "conversation",
      name: "General conversation",
      description: "Send a message and receive a response",
      tags: ["chat"],
    });
  });

  test("constructs correct interface URL with trailing-slash base", () => {
    const card = buildAgentCard({
      ...BASE_PARAMS,
      baseUrl: "https://example.com/",
    });

    // The URL is constructed by simple concatenation; callers normalize the base.
    expect(card.supported_interfaces[0].url).toBe(
      "https://example.com//a2a/message:send",
    );
  });
});
