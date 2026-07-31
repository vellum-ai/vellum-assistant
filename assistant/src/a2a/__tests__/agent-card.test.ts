import { describe, expect, test } from "bun:test";

import { buildAgentCard } from "../agent-card.js";

describe("buildAgentCard", () => {
  const BASE_PARAMS = {
    assistantName: "Alice",
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

  // A2A message exchange runs over the authenticated invite flow, so there is
  // no peer-callable protocol endpoint for the card to point at.
  test("advertises no protocol interfaces", () => {
    const card = buildAgentCard(BASE_PARAMS);

    expect(card.supported_interfaces).toEqual([]);
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

    expect(card.description).toBe("Alice - a Vellum AI assistant");
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
});
