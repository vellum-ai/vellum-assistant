import { describe, expect, test } from "bun:test";

import type { Message } from "../../../../providers/types.js";
import { buildAdvisorContext, deriveRecallQuery } from "../context-pack.js";

const userMsg = (t: string): Message => ({
  role: "user",
  content: [{ type: "text", text: t }],
});

describe("deriveRecallQuery", () => {
  test("returns the most recent user message text", () => {
    const query = deriveRecallQuery([
      userMsg("the original task"),
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      userMsg("the latest question"),
    ]);
    expect(query).toBe("the latest question");
  });

  test("returns null when there is no user text", () => {
    expect(
      deriveRecallQuery([
        { role: "assistant", content: [{ type: "text", text: "hi" }] },
      ]),
    ).toBeNull();
    expect(deriveRecallQuery([])).toBeNull();
  });

  test("skips a trivial acknowledgement and recalls the substantive request", () => {
    const query = deriveRecallQuery([
      userMsg("refactor the auth worker pool to drain on shutdown"),
      { role: "assistant", content: [{ type: "text", text: "here's a plan…" }] },
      userMsg("go ahead"),
    ]);
    expect(query).toBe("refactor the auth worker pool to drain on shutdown");
  });

  test("treats punctuated/cased acknowledgements as trivial too", () => {
    for (const ack of ["Go ahead!", "Yes.", "do it", "  ok  ", "👍"]) {
      const query = deriveRecallQuery([
        userMsg("design the streaming protocol"),
        userMsg(ack),
      ]);
      expect(query).toBe("design the streaming protocol");
    }
  });

  test("falls back to the latest user text when every turn is an acknowledgement", () => {
    const query = deriveRecallQuery([userMsg("yes"), userMsg("go ahead")]);
    expect(query).toBe("go ahead");
  });
});

describe("buildAdvisorContext", () => {
  test("lists the agent's available tools, skipping the advisor itself", async () => {
    const context = await buildAdvisorContext({
      conversationId: "ctx-1",
      workingDir: "/tmp/does-not-exist",
      allowedToolNames: new Set(["bash", "advisor", "read_file"]),
      trustClass: "unknown",
      transcript: [userMsg("hi")],
    });

    expect(context).toContain("## Available tools");
    expect(context).toContain("- bash");
    expect(context).toContain("- read_file");
    // The advisor advises; it never tells the agent to consult itself.
    expect(context).not.toContain("- advisor");
  });

  test("omits the tools section when no tools are available", async () => {
    const context = await buildAdvisorContext({
      conversationId: "ctx-2",
      workingDir: "/tmp/does-not-exist",
      allowedToolNames: new Set(),
      trustClass: "unknown",
      transcript: [],
    });
    // Other sources (e.g. the skills catalog) may still contribute, but with no
    // allowed tools the tools section must not appear.
    if (context !== null) expect(context).not.toContain("## Available tools");
  });
});
