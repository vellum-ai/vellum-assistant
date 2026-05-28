import { afterEach, describe, expect, test } from "bun:test";

import { evalFromSpec } from "../../judge";

const originalFetch = globalThis.fetch;

function mockOpenAI(content: string) {
  const captured: { body?: Record<string, unknown> } = {};
  globalThis.fetch = (async (
    _url: string | URL | Request,
    init?: RequestInit,
  ) => {
    if (init?.body !== undefined) {
      captured.body = JSON.parse(String(init.body)) as Record<string, unknown>;
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return captured;
}

describe("evalFromSpec dispatcher", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("dispatches norm_phrase_set_match and reports the function name", async () => {
    const result = await evalFromSpec("norm_phrase_set_match", {
      prediction: "the project settings page is /settings/project",
      answer: "/settings/project",
    });
    expect(result).toEqual({
      label: true,
      reason: "",
      function: "norm_phrase_set_match",
    });
  });

  test("dispatches norm_phrase_set_match_ordered with separator kwargs from spec", async () => {
    const result = await evalFromSpec(
      "norm_phrase_set_match_ordered|separators=>",
      {
        prediction: "click Dashboards then New then template then Save",
        answer: "Dashboards > New > template > Save",
      },
    );
    expect(result.label).toBe(true);
    expect(result.function).toBe("norm_phrase_set_match_ordered");
  });

  test("dispatches mc_choice_match", async () => {
    const result = await evalFromSpec("mc_choice_match", {
      prediction: "Choice B.",
      answer: "B",
    });
    expect(result.label).toBe(true);
    expect(result.function).toBe("mc_choice_match");
  });

  test("dispatches mc_choice_set_match", async () => {
    const result = await evalFromSpec("mc_choice_set_match", {
      prediction: "Final answer: A and C",
      answer: "C, A",
    });
    expect(result.label).toBe(true);
    expect(result.function).toBe("mc_choice_set_match");
  });

  test("dispatches llm_abstention_checker through the OpenAI transport", async () => {
    mockOpenAI('{"label": 1, "reason": "premise rejected"}');

    const result = await evalFromSpec(
      "llm_abstention_checker",
      {
        prediction: "The premise here is wrong because X.",
        answer: "Reject the premise.",
        questionItem: { question: "Why does Z fail?" },
      },
      { evaluatorModel: "gpt-5.2", evaluatorApiKey: "unit-test" },
    );

    expect(result).toEqual({
      label: true,
      reason: "premise rejected",
      function: "llm_abstention_checker",
    });
  });

  test("dispatches llm_gotchas_checker through the OpenAI transport", async () => {
    mockOpenAI('{"label": 1, "reason": "captures insight"}');

    const result = await evalFromSpec(
      "llm_gotchas_checker",
      {
        prediction: "You need to refresh the cache first.",
        answer: "Cache must be invalidated before reload.",
      },
      { evaluatorModel: "gpt-5.2", evaluatorApiKey: "unit-test" },
    );

    expect(result.label).toBe(true);
    expect(result.function).toBe("llm_gotchas_checker");
  });

  test("caller overrides win over spec kwargs", async () => {
    // Spec sets requireNonEmpty=true; override forces false so an empty
    // answer still matches.
    const result = await evalFromSpec(
      "norm_phrase_set_match|require_non_empty=true",
      { prediction: "non-empty", answer: "" },
      { requireNonEmpty: false },
    );
    expect(result.label).toBe(true);
  });

  test("throws on unknown function name", async () => {
    await expect(
      evalFromSpec("definitely_not_real", { prediction: "x", answer: "y" }),
    ).rejects.toThrow(/Unknown eval function/);
  });

  test("propagates parse errors on malformed spec strings", async () => {
    await expect(
      evalFromSpec("norm_phrase_set_match|noequals", {
        prediction: "x",
        answer: "y",
      }),
    ).rejects.toThrow(/Invalid eval function option/);
  });
});
