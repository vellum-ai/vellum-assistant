import { describe, expect, test } from "bun:test";

import {
  salvageXmlToolCalls,
  shouldSalvageXmlToolCalls,
  splitXmlToolCallHoldback,
} from "../xml-tool-call-salvage.js";

const OFFERED = new Set(["bash", "file_read", "ui_show"]);

describe("salvageXmlToolCalls", () => {
  test("converts a DeepSeek-style bash invoke into a structured call", () => {
    const text = `Let me actually run the check.

<invoke name="bash">
<parameter name="command">cd /workspace/example && git status</parameter>
<parameter name="activity">Checking live repo state</parameter>
<parameter name="timeout_seconds">60</parameter>
</invoke>`;

    const salvaged = salvageXmlToolCalls(text, OFFERED);
    expect(salvaged).not.toBeNull();
    expect(salvaged!.text).toBe("Let me actually run the check.");
    expect(salvaged!.calls).toEqual([
      {
        name: "bash",
        input: {
          command: "cd /workspace/example && git status",
          activity: "Checking live repo state",
          timeout_seconds: 60,
        },
      },
    ]);
  });

  test("salvages multiple invokes and strips an empty function_calls wrapper", () => {
    const text = `<function_calls>
<invoke name="file_read">
<parameter name="path">/workspace/README.md</parameter>
</invoke>
<invoke name="bash">
<parameter name="command">ls</parameter>
</invoke>
</function_calls>`;

    const salvaged = salvageXmlToolCalls(text, OFFERED);
    expect(salvaged!.text).toBe("");
    expect(salvaged!.calls.map((call) => call.name)).toEqual([
      "file_read",
      "bash",
    ]);
  });

  test("leaves unknown tool names as text", () => {
    const text = `<invoke name="not_a_real_tool">
<parameter name="command">rm -rf /</parameter>
</invoke>`;

    expect(salvageXmlToolCalls(text, OFFERED)).toBeNull();
  });

  test("salvages offered tools and leaves unknown invokes in the leftover text", () => {
    const text = `<invoke name="bash">
<parameter name="command">pwd</parameter>
</invoke>
<invoke name="not_a_real_tool">
<parameter name="command">nope</parameter>
</invoke>`;

    const salvaged = salvageXmlToolCalls(text, OFFERED);
    expect(salvaged!.calls).toEqual([
      { name: "bash", input: { command: "pwd" } },
    ]);
    expect(salvaged!.text).toContain('name="not_a_real_tool"');
    expect(salvaged!.text).not.toContain('name="bash"');
  });

  test("does not salvage a truncated invoke", () => {
    const text = `<invoke name="bash">
<parameter name="command">git status</parameter>
<parameter name="activity">Checking`;

    expect(salvageXmlToolCalls(text, OFFERED)).toBeNull();
  });

  test("matches offered tool names case-insensitively", () => {
    const salvaged = salvageXmlToolCalls(
      `<invoke name="Bash"><parameter name="command">echo hi</parameter></invoke>`,
      OFFERED,
    );
    expect(salvaged!.calls[0]?.name).toBe("bash");
  });

  test("returns null when no tools were offered", () => {
    const text = `<invoke name="bash"><parameter name="command">ls</parameter></invoke>`;
    expect(salvageXmlToolCalls(text, new Set())).toBeNull();
  });

  test("decodes XML entities in parameter values", () => {
    const salvaged = salvageXmlToolCalls(
      `<invoke name="bash"><parameter name="command">echo &quot;a &amp; b&quot;</parameter></invoke>`,
      OFFERED,
    );
    expect(salvaged!.calls[0]?.input.command).toBe('echo "a & b"');
  });

  test("leaves invokes inside markdown fences as text", () => {
    const text = `Example:

\`\`\`xml
<invoke name="bash">
<parameter name="command">ls</parameter>
</invoke>
\`\`\``;

    expect(salvageXmlToolCalls(text, OFFERED)).toBeNull();
  });

  test("salvages an unfenced invoke next to a fenced example", () => {
    const text = `<invoke name="bash"><parameter name="command">pwd</parameter></invoke>

\`\`\`
<invoke name="file_read"><parameter name="path">/workspace/README.md</parameter></invoke>
\`\`\``;

    const salvaged = salvageXmlToolCalls(text, OFFERED);
    expect(salvaged!.calls).toEqual([{ name: "bash", input: { command: "pwd" } }]);
    expect(salvaged!.text).toContain('name="file_read"');
  });
});

describe("shouldSalvageXmlToolCalls", () => {
  test("is true for DeepSeek model ids", () => {
    expect(
      shouldSalvageXmlToolCalls(
        "accounts/fireworks/models/deepseek-v4-flash-0731",
      ),
    ).toBe(true);
    expect(shouldSalvageXmlToolCalls("deepseek/deepseek-v4-flash")).toBe(true);
  });

  test("is false for other models", () => {
    expect(shouldSalvageXmlToolCalls("gpt-5.6")).toBe(false);
    expect(shouldSalvageXmlToolCalls("accounts/fireworks/models/minimax-m3")).toBe(
      false,
    );
    expect(shouldSalvageXmlToolCalls(undefined)).toBe(false);
  });
});

describe("splitXmlToolCallHoldback", () => {
  test("holds a complete invoke opener and the rest of the buffer", () => {
    expect(splitXmlToolCallHoldback("Sure.\n<invoke name=\"bash\">")).toEqual({
      visible: "Sure.\n",
      held: `<invoke name="bash">`,
    });
  });

  test("holds a partial opener split across chunks", () => {
    expect(splitXmlToolCallHoldback("Okay.<inv")).toEqual({
      visible: "Okay.",
      held: "<inv",
    });
  });

  test("passes through text with no opener", () => {
    expect(splitXmlToolCallHoldback("Hello there.")).toEqual({
      visible: "Hello there.",
      held: "",
    });
  });
});
