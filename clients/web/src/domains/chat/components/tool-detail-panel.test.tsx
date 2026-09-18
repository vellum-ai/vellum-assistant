/**
 * Tests for `ToolDetailPanel`, the side-drawer body for a tool-call step.
 *
 * Runs under happy-dom (see clients/web/test-setup.ts) so we can render
 * interactively and assert click / clipboard behavior.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render as rtlRender,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// `ToolDetailPanel`'s thinking variant subscribes to the chat-session store,
// which transitively pulls in the generated daemon SDK. Stub every endpoint it
// exports so the module loads, then import dynamically so the mock is registered
// first. Mirrors the comprehensive mock in `multi-activity-group.test.tsx`.
const sdkStub = async () => ({ data: undefined });
const realSdkPath = new URL(
  "../../../generated/daemon/sdk.gen.ts",
  import.meta.url,
).pathname;
const sdkSource = await Bun.file(realSdkPath).text();
const exportNames = [...sdkSource.matchAll(/^export const (\w+)/gm)].map(
  (m) => m[1]!,
);
const sdkMock = Object.fromEntries(exportNames.map((n) => [n, sdkStub]));
mock.module("@/generated/daemon/sdk.gen", () => sdkMock);

const { ToolDetailPanel } =
  await import("@/domains/chat/components/tool-detail-panel");
const { useChatSessionStore } =
  await import("@/domains/chat/chat-session-store");
import type { ToolDetailPayload } from "@/stores/viewer-store";
import type { DisplayMessage } from "@/domains/chat/types/types";
import type { PaginatedHistoryResult } from "@/domains/chat/transcript/types";
import {
  stubContentHeight,
  stubOverflow,
  stubResizeObserver,
} from "@/hooks/overflow.test-helper";

/** Wrap messages into a materialized-snapshot page. */
function snap(messages: DisplayMessage[]): PaginatedHistoryResult {
  return {
    messages,
    seq: null,
    hasMore: false,
    oldestTimestamp: null,
    oldestMessageId: null,
  };
}

const noop = () => {};

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

const render = (ui: Parameters<typeof rtlRender>[0]) =>
  rtlRender(ui, { wrapper });

/**
 * Seed a committed message so the drawer's transcript resolves it. History now
 * folds into the materialized snapshot, so this writes the snapshot.
 */
function seedHistory(messages: DisplayMessage[]) {
  // History folds into the materialized snapshot (the single source the
  // drawer reads), so seed it there.
  useChatSessionStore.setState({ snapshot: snap(messages) });
}

function makeDetail(
  overrides: Partial<ToolDetailPayload> = {},
): ToolDetailPayload {
  return {
    toolCallId: "tc-1",
    toolName: "subagent_spawn",
    title: "Spawning subagent",
    activity: "Spawning subagent to research Toronto's location",
    input: { label: "toronto-location", role: "researcher" },
    result: '{"summary":"Toronto is in Ontario, Canada."}',
    status: "completed",
    riskLevel: "low",
    ...overrides,
  };
}

let writeText: ReturnType<typeof mock>;
/** Set by a test that stubs layout; `afterEach` restores it. */
let restoreLayout: (() => void) | null = null;

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  writeText = mock(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

afterEach(() => {
  restoreLayout?.();
  restoreLayout = null;
  cleanup();
  act(() => {
    useChatSessionStore.setState({ snapshot: null, optimisticSends: [] });
  });
  queryClient.clear();
});

describe("ToolDetailPanel", () => {
  test("renders the activity title, friendly tool name, parameters and output", () => {
    const { getAllByText, getByText, container } = render(
      <ToolDetailPanel detail={makeDetail()} onClose={noop} />,
    );

    // The header owns the activity sentence, and the body does not repeat it.
    expect(
      getAllByText("Spawning subagent to research Toronto's location"),
    ).toHaveLength(1);
    // The tool is named once, in the header beneath the activity.
    expect(getAllByText("Subagent Spawn")).toHaveLength(1);
    // Each parameter is a field of its key and its value, not a JSON literal.
    expect(getByText("label")).toBeDefined();
    expect(getByText("toronto-location")).toBeDefined();
    const text = container.textContent ?? "";
    expect(text).not.toContain('"toronto-location"');
    expect(text).toContain("Toronto is in Ontario, Canada.");
  });

  test("keeps the raw input, activity included, one disclosure away", () => {
    const detail = makeDetail({
      input: {
        activity: "Spawning subagent to research Toronto's location",
        label: "toronto-location",
      },
    });
    const { getByText, queryByText, container } = render(
      <ToolDetailPanel detail={detail} onClose={noop} />,
    );

    // The header already shows the activity sentence, so it is not a field.
    expect(queryByText("activity")).toBeNull();
    expect(container.textContent).not.toContain('"activity"');

    act(() => {
      fireEvent.click(getByText("Raw input"));
    });

    expect(container.textContent).toContain('"activity"');
    expect(container.textContent).toContain('"toronto-location"');
  });

  test("shows only the raw input when the call has no parameters", () => {
    const { getByText, queryByText } = render(
      <ToolDetailPanel detail={makeDetail({ input: {} })} onClose={noop} />,
    );

    expect(queryByText("Parameters")).toBeNull();
    expect(getByText("Raw input")).toBeDefined();
  });

  test("renders a structured parameter as labelled fields, not JSON", () => {
    const detail = makeDetail({
      toolName: "acme_crm_upsert_contact",
      input: {
        record: {
          stage: "qualified",
          owner: { team: "growth" },
          tags: ["inbound", "trial"],
        },
      },
    });
    const { getByText, container } = render(
      <ToolDetailPanel detail={detail} onClose={noop} />,
    );

    expect(getByText("record")).toBeDefined();
    expect(getByText("stage")).toBeDefined();
    expect(getByText("qualified")).toBeDefined();
    // A small object reads as key and value pairs on one line.
    expect(getByText("owner")).toBeDefined();
    expect(getByText("team")).toBeDefined();
    // A short list reads as one line.
    expect(getByText("inbound, trial")).toBeDefined();
    expect(container.textContent).not.toContain('"stage"');
  });

  test("renders a list of records as a table, one column per key", () => {
    const detail = makeDetail({
      toolName: "acme_crm_import_contacts",
      input: {
        contacts: [
          { email: "ada@example.com", stage: "qualified", owner: "growth" },
          { email: "grace@example.com", stage: "new" },
        ],
      },
    });
    const { getAllByRole, queryByText } = render(
      <ToolDetailPanel detail={detail} onClose={noop} />,
    );

    expect(
      getAllByRole("columnheader").map((header) => header.textContent),
    ).toEqual(["email", "stage", "owner"]);
    const cellsOf = (row: HTMLElement) =>
      within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent);
    const [, first, second] = getAllByRole("row");
    expect(first && cellsOf(first)).toEqual([
      "ada@example.com",
      "qualified",
      "growth",
    ]);
    // The record without an owner keeps its row, with that cell empty.
    expect(second && cellsOf(second)).toEqual(["grace@example.com", "new", ""]);
    // A cell is a machine value, set in the same monospace as the other values.
    const firstCell = first && within(first).getAllByRole("cell")[0];
    expect(firstCell?.querySelector(".font-mono")?.textContent).toBe(
      "ada@example.com",
    );
    // No positional labels: the records are rows, not a numbered group.
    expect(queryByText("1")).toBeNull();
  });

  test("reads a one-line value inline whatever its length", () => {
    const query =
      "SELECT week, count(DISTINCT person_id) AS users FROM events GROUP BY week ORDER BY week";
    const detail = makeDetail({
      toolName: "mcp__analytics__exec",
      input: { query },
    });
    const { getByText, getByLabelText } = render(
      <ToolDetailPanel detail={detail} onClose={noop} />,
    );

    expect(getByText(query).tagName).not.toBe("PRE");
    // The query's own copy button copies the query alone, not the raw input.
    fireEvent.click(getByLabelText("Copy query"));
    expect(writeText).toHaveBeenCalledWith(query);
  });

  test("sets text with line breaks as a code block copied from its label", () => {
    const query = "SELECT week\nFROM events";
    const detail = makeDetail({
      toolName: "mcp__analytics__exec",
      input: { query },
      result: "4 rows",
    });
    const { container, getAllByLabelText, getByLabelText } = render(
      <ToolDetailPanel detail={detail} onClose={noop} />,
    );

    const blocks = [...container.querySelectorAll("pre")].map(
      (pre) => pre.textContent,
    );
    expect(blocks).toContain(query);
    // The block carries no copy button of its own; the only unlabelled one
    // is the output's.
    expect(getAllByLabelText("Copy")).toHaveLength(1);
    fireEvent.click(getByLabelText("Copy query"));
    expect(writeText).toHaveBeenCalledWith(query);
  });

  test("copies a table field from its label, with no separate table control", () => {
    const contacts = [
      { email: "user1@example.com", stage: "new" },
      { email: "user2@example.com", stage: "trial" },
    ];
    const detail = makeDetail({
      toolName: "acme_crm_import_contacts",
      input: { contacts },
    });
    const { getByLabelText, queryByLabelText } = render(
      <ToolDetailPanel detail={detail} onClose={noop} />,
    );

    expect(queryByLabelText("Copy table as markdown")).toBeNull();
    fireEvent.click(getByLabelText("Copy contacts"));
    expect(writeText).toHaveBeenCalledWith(JSON.stringify(contacts, null, 2));
  });

  test("reveals only the hovered field's copy button inside a group", () => {
    const detail = makeDetail({
      toolName: "acme_crm_upsert_contact",
      input: {
        record: {
          stage: "qualified",
          address: { city: "Lisbon", country: "Portugal" },
        },
      },
    });
    const { container, getByLabelText } = render(
      <ToolDetailPanel detail={detail} onClose={noop} />,
    );

    // Hover reaches every row around the pointer, so a row that held
    // another row would reveal its own button along with the inner one.
    expect(
      container.querySelectorAll("[data-reveal-row] [data-reveal-row]"),
    ).toHaveLength(0);
    for (const label of ["Copy record", "Copy stage", "Copy address"]) {
      expect(getByLabelText(label).closest("[data-reveal-row]")).not.toBeNull();
    }
  });

  test("folds a long one-line value behind Show more", () => {
    const note = "word ".repeat(200).trim();
    restoreLayout = stubOverflow((el) => el.textContent === note);
    const detail = makeDetail({
      toolName: "acme_notes_append",
      input: { note },
      result: "",
    });
    const { getByText, getAllByText } = render(
      <ToolDetailPanel detail={detail} onClose={noop} />,
    );

    expect(getByText(note).tagName).not.toBe("PRE");
    expect(getAllByText("Show more")).toHaveLength(1);
  });

  describe("an opened value", () => {
    const note = "word ".repeat(200).trim();
    const detail = makeDetail({
      toolName: "acme_notes_append",
      input: { note },
      result: "",
    });

    /**
     * Opens the value in `openedDetail` that folds, given the height it draws
     * at, and lays it out again as the browser would once it has opened.
     */
    function openValue(openedDetail: ToolDetailPayload, height: number) {
      // Only the fold's box carries a max-height, so it is what measures.
      restoreLayout = stubContentHeight((el) =>
        el.style.maxHeight ? height : undefined,
      );
      const observer = stubResizeObserver();
      try {
        const view = render(
          <ToolDetailPanel detail={openedDetail} onClose={noop} />,
        );
        act(() => {
          fireEvent.click(view.getByText("Show more"));
        });
        act(observer.resize);
        return view;
      } finally {
        observer.restore();
      }
    }

    const openNote = (height: number) => openValue(detail, height);

    test("stops at the expanded height and scrolls, named after its field", () => {
      const { getByRole, getByText } = openNote(1000);

      const box = getByRole("region", { name: "note" });
      expect(box.style.maxHeight).toBe("480px");
      expect(box.tabIndex).toBe(0);
      expect(getByText("Show less")).toBeDefined();
    });

    test("names a whole output after its section", () => {
      const rows = Array.from({ length: 40 }, (_, index) => ({
        id: `row-${index + 1}`,
        stage: "new",
      }));
      const { getByRole } = openValue(
        makeDetail({
          toolName: "acme_crm_list_contacts",
          input: {},
          result: JSON.stringify(rows),
        }),
        1000,
      );

      expect(getByRole("region", { name: "Output" })).toBeDefined();
    });

    test("folds back to its start after scrolling while open", () => {
      const { getByRole, getByText } = openNote(1000);
      const box = getByRole("region", { name: "note" });
      box.scrollTop = 300;

      act(() => {
        fireEvent.click(getByText("Show less"));
      });

      expect(box.scrollTop).toBe(0);
    });

    test("shows whole, with nothing to scroll, when it fits that height", () => {
      const { queryByRole, getByText } = openNote(300);

      expect(queryByRole("region")).toBeNull();
      expect(getByText("Show less")).toBeDefined();
    });
  });

  test("folds a table taller than the fold as one value", () => {
    const notes = Array.from({ length: 12 }, (_, index) => ({
      title: `note-${index + 1}`,
      body: "short",
    }));
    restoreLayout = stubOverflow(
      (el) =>
        el.querySelector("table") !== null &&
        el.textContent.includes("note-12"),
    );
    const { getAllByText, getByText } = render(
      <ToolDetailPanel
        detail={makeDetail({
          toolName: "acme_notes_import",
          input: { notes },
          result: "",
        })}
        onClose={noop}
      />,
    );

    // One Show more for the whole table, not one per cell.
    expect(getAllByText("Show more")).toHaveLength(1);
    expect(getByText("note-12")).toBeDefined();
  });

  test("folds a nested group taller than the fold as one value", () => {
    const record = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [`field_${index + 1}`, "x"]),
    );
    restoreLayout = stubOverflow((el) => el.textContent.startsWith("field_1"));
    const { getAllByText } = render(
      <ToolDetailPanel
        detail={makeDetail({
          toolName: "acme_crm_upsert_contact",
          input: { record },
          result: "",
        })}
        onClose={noop}
      />,
    );

    expect(getAllByText("Show more")).toHaveLength(1);
  });

  test("opens a long field inside a folded group with the group's one Show more", () => {
    const summary = "word ".repeat(200).trim();
    const record = { stage: "qualified", summary };
    // The long field is taller than the fold on its own, and so is its group.
    restoreLayout = stubOverflow((el) => el.textContent.includes(summary));
    const { getAllByText, getByText, queryByText } = render(
      <ToolDetailPanel
        detail={makeDetail({
          toolName: "acme_crm_upsert_contact",
          input: { record },
          result: "",
        })}
        onClose={noop}
      />,
    );

    expect(getAllByText("Show more")).toHaveLength(1);
    act(() => {
      fireEvent.click(getByText("Show more"));
    });
    // Nothing is left folded inside the opened group.
    expect(queryByText("Show more")).toBeNull();
    expect(getAllByText("Show less")).toHaveLength(1);
  });

  test("counts the items past the first twenty instead of listing them", () => {
    const ids = Array.from({ length: 23 }, (_, index) => `id-${index + 1}`);
    const detail = makeDetail({
      toolName: "acme_bulk_archive",
      input: { ids },
    });
    const { getByText, queryByText } = render(
      <ToolDetailPanel detail={detail} onClose={noop} />,
    );

    expect(getByText("id-20")).toBeDefined();
    expect(queryByText("id-21")).toBeNull();
    expect(getByText("3 more in Raw input")).toBeDefined();
  });

  test("omits the Technical details label", () => {
    const { queryByText } = render(
      <ToolDetailPanel detail={makeDetail()} onClose={noop} />,
    );

    expect(queryByText("Technical details")).toBeNull();
  });

  test("shows the risk level as a pill, without the raw classifier reason", () => {
    const { getByTestId, queryByText } = render(
      <ToolDetailPanel
        detail={makeDetail({ riskReason: "File edit (default)" })}
        onClose={noop}
      />,
    );

    expect(getByTestId("risk-badge").getAttribute("data-risk-level")).toBe(
      "low",
    );
    expect(getByTestId("risk-badge").textContent).toBe("Low");
    // The tolerance sentence is the pill's tooltip, not standing copy.
    expect(
      queryByText("Auto-approved at Conservative tolerance or higher"),
    ).toBeNull();
    // The classifier's rule-match string is internal jargon, never shown.
    expect(queryByText("File edit (default)")).toBeNull();
    // The trust-rule affordance was removed from the drawer.
    expect(queryByText("Create Trust Rule")).toBeNull();
  });

  test("shows no pill when the call has no risk level", () => {
    const { queryByTestId } = render(
      <ToolDetailPanel
        detail={makeDetail({ riskLevel: undefined })}
        onClose={noop}
      />,
    );

    expect(queryByTestId("risk-badge")).toBeNull();
  });

  test("does not render a Create Trust Rule button even when the call resolves live", () => {
    seedHistory([
      {
        id: "m1",
        role: "assistant",
        toolCalls: [{ id: "tc-1", name: "subagent_spawn", riskLevel: "low" }],
      } as DisplayMessage,
    ]);
    const { queryByText } = render(
      <ToolDetailPanel detail={makeDetail()} onClose={noop} />,
    );

    expect(queryByText("Create Trust Rule")).toBeNull();
  });

  test("reports an empty result rather than dropping the Output section", () => {
    const { getByText, getByTestId } = render(
      <ToolDetailPanel detail={makeDetail({ result: "" })} onClose={noop} />,
    );

    expect(getByText("Output")).toBeDefined();
    expect(getByTestId("tool-output-notice").textContent).toBe(
      "The tool returned no output.",
    );
  });

  test("collapses whitespace in the header title", () => {
    // The activity sentence is model-written; a newline in it would render as
    // a gap in a single-line header.
    const { container } = render(
      <ToolDetailPanel
        detail={makeDetail({
          activity: "  Reading the risk helpers\n  and the badge styles  ",
        })}
        onClose={noop}
      />,
    );

    // Asserted on the raw node rather than through `getByText`, whose default
    // normalizer collapses whitespace itself and so cannot tell a sanitized
    // title from an unsanitized one.
    const heading = container.querySelector("[title]");
    expect(heading?.getAttribute("title")).toBe(
      "Reading the risk helpers and the badge styles",
    );
    expect(heading?.textContent).toBe(
      "Reading the risk helpers and the badge styles",
    );
  });

  test("falls back to the phase title when there is no activity", () => {
    const { getByText } = render(
      <ToolDetailPanel
        detail={makeDetail({ activity: "", title: "Spawning subagent" })}
        onClose={noop}
      />,
    );

    expect(getByText("Spawning subagent")).toBeDefined();
  });

  test("says a denied call did not run", () => {
    const { getByText, getByTestId } = render(
      <ToolDetailPanel
        detail={makeDetail({ result: undefined, status: "denied" })}
        onClose={noop}
      />,
    );

    expect(getByText("Output")).toBeDefined();
    expect(getByTestId("tool-output-notice").textContent).toBe(
      "This tool call was not approved, so it did not run.",
    );
  });

  test("keeps saying a denied call did not run once its denial result lands", () => {
    // The daemon answers a refusal with a result addressed to the model. It is
    // not output, so the reader still sees why the call did not run.
    const { getByTestId, queryByText } = render(
      <ToolDetailPanel
        detail={makeDetail({
          result:
            'Permission denied. The "subagent_spawn" tool was not allowed. Do NOT retry this tool call immediately.',
          status: "denied",
        })}
        onClose={noop}
      />,
    );

    expect(getByTestId("tool-output-notice").textContent).toBe(
      "This tool call was not approved, so it did not run.",
    );
    expect(queryByText(/Do NOT retry/)).toBeNull();
  });

  test("picks up a denial that lands while the drawer is open", () => {
    // The payload was captured before the guardian answered, so the snapshot
    // still says the call was running. The live tool call carries the decision.
    seedHistory([
      {
        id: "m1",
        role: "assistant",
        toolCalls: [
          {
            id: "tc-1",
            name: "subagent_spawn",
            confirmationDecision: "denied",
          },
        ],
      } as DisplayMessage,
    ]);
    const { getByTestId } = render(
      <ToolDetailPanel
        detail={makeDetail({ result: undefined, status: "running" })}
        onClose={noop}
      />,
    );

    expect(getByTestId("tool-output-notice").textContent).toBe(
      "This tool call was not approved, so it did not run.",
    );
  });

  test("treats a timed-out confirmation as not approved", () => {
    seedHistory([
      {
        id: "m1",
        role: "assistant",
        toolCalls: [
          {
            id: "tc-1",
            name: "subagent_spawn",
            confirmationDecision: "timed_out",
          },
        ],
      } as DisplayMessage,
    ]);
    const { getByTestId } = render(
      <ToolDetailPanel
        detail={makeDetail({ result: undefined, status: "running" })}
        onClose={noop}
      />,
    );

    expect(getByTestId("tool-output-notice").textContent).toBe(
      "This tool call was not approved, so it did not run.",
    );
  });

  test("folds a result taller than the fold behind Show more", () => {
    const long = "a line of output\n".repeat(200);
    restoreLayout = stubOverflow((el) => el.textContent === long);
    const { getByText, queryByText } = render(
      <ToolDetailPanel detail={makeDetail({ result: long })} onClose={noop} />,
    );

    const toggle = getByText("Show more");
    expect(toggle).toBeDefined();
    act(() => {
      fireEvent.click(toggle);
    });
    expect(getByText("Show less")).toBeDefined();
    expect(queryByText("Show more")).toBeNull();
  });

  test("drops Show less when the drawer moves to a call whose output fits", () => {
    // The drawer stays mounted from one call to the next, so an opened fold
    // can have its content replaced under it.
    const long = "a line of output\n".repeat(200);
    restoreLayout = stubOverflow((el) => el.textContent === long);
    const observer = stubResizeObserver();
    try {
      const { getByText, queryByText, rerender } = render(
        <ToolDetailPanel
          detail={makeDetail({ result: long })}
          onClose={noop}
        />,
      );
      act(() => {
        fireEvent.click(getByText("Show more"));
      });
      expect(getByText("Show less")).toBeDefined();

      rerender(
        <ToolDetailPanel
          detail={makeDetail({ toolCallId: "tc-next", result: "done" })}
          onClose={noop}
        />,
      );
      act(observer.resize);

      expect(queryByText("Show less")).toBeNull();
      expect(queryByText("Show more")).toBeNull();
    } finally {
      observer.restore();
    }
  });

  test("offers no Show more for long text that fits the fold", () => {
    // Long in characters, but it fits where it is drawn, so nothing is hidden.
    const result = "word ".repeat(300).trim();
    const { queryByText } = render(
      <ToolDetailPanel detail={makeDetail({ result })} onClose={noop} />,
    );

    expect(queryByText("Show more")).toBeNull();
  });

  test("leaves a short result unclamped", () => {
    const { queryByText } = render(
      <ToolDetailPanel
        detail={makeDetail({ result: "two words" })}
        onClose={noop}
      />,
    );

    expect(queryByText("Show more")).toBeNull();
  });

  test("reports no output for a call that finished without a result", () => {
    const { getByText, getByTestId } = render(
      <ToolDetailPanel
        detail={makeDetail({ result: undefined, status: "completed" })}
        onClose={noop}
      />,
    );

    expect(getByText("Output")).toBeDefined();
    expect(getByTestId("tool-output-notice").textContent).toBe(
      "The tool returned no output.",
    );
  });

  test("shows a Running placeholder while running with no result", () => {
    const { getByText } = render(
      <ToolDetailPanel
        detail={makeDetail({ result: undefined, status: "running" })}
        onClose={noop}
      />,
    );

    expect(getByText("Output")).toBeDefined();
    expect(getByText("Running…")).toBeDefined();
  });

  test("labels a denied edit as requested, not applied", () => {
    const { getByText, queryByText } = render(
      <ToolDetailPanel
        detail={makeDetail({
          toolName: "file_edit",
          input: { path: "a.ts", old_string: "one", new_string: "two" },
          result: undefined,
          status: "denied",
        })}
        onClose={noop}
      />,
    );

    // The diff describes what was asked for; only a call that succeeded had it
    // applied, so a denied one must not read as a change that happened.
    expect(getByText("Requested changes")).toBeDefined();
    expect(queryByText("Changes")).toBeNull();
  });

  test("labels a successful edit as applied", () => {
    const { getByText } = render(
      <ToolDetailPanel
        detail={makeDetail({
          toolName: "file_edit",
          input: { path: "a.ts", old_string: "one", new_string: "two" },
          result: "Applied 1 edit",
          status: "completed",
        })}
        onClose={noop}
      />,
    );

    expect(getByText("Changes")).toBeDefined();
  });

  test("shows the edited path when it arrives as file_path", () => {
    const { getByText } = render(
      <ToolDetailPanel
        detail={makeDetail({
          toolName: "file_edit",
          // The daemon's alias table rewrites `file_path` to `path` only for
          // aliased tool names, so a direct `file_edit` call still carries this
          // spelling, and every surface that shows a path accepts all three.
          input: {
            file_path: "src/deep/module.ts",
            old_string: "one",
            new_string: "two",
          },
          result: "Applied 1 edit",
        })}
        onClose={noop}
      />,
    );

    expect(getByText("src/deep/module.ts")).toBeDefined();
  });

  test("shows a write's file even when its input carries stray edit keys", () => {
    const { getByText, queryByTestId } = render(
      <ToolDetailPanel
        detail={makeDetail({
          toolName: "file_write",
          // The write schemas are `z.looseObject`, so unread fields survive
          // validation. The rendering follows the tool, not the input keys.
          input: {
            path: "src/a.ts",
            content: "const written = true;",
            old_string: "",
            new_string: "",
          },
          result: "Wrote 1 line to src/a.ts",
        })}
        onClose={noop}
      />,
    );

    expect(getByText("const written = true;")).toBeDefined();
    expect(queryByTestId("file-diff")).toBeNull();
  });

  test("names the path the tool reads when both spellings are present", () => {
    const { getByText, queryByText } = render(
      <ToolDetailPanel
        detail={makeDetail({
          toolName: "file_write",
          // `path` is what the executor reads, and what the alias table
          // rewrites the other spelling into, so it wins either way.
          input: {
            path: "src/executed.ts",
            file_path: "src/ignored.ts",
            content: "const a = 1;",
          },
          result: "Wrote 1 line",
        })}
        onClose={noop}
      />,
    );

    expect(getByText("src/executed.ts")).toBeDefined();
    expect(queryByText("src/ignored.ts")).toBeNull();
  });

  test("labels a denied write as requested, the same as a denied edit", () => {
    const { getByText, queryByText } = render(
      <ToolDetailPanel
        detail={makeDetail({
          toolName: "file_write",
          input: { path: "src/a.ts", content: "const a = 1;\n" },
          result: undefined,
          status: "denied",
        })}
        onClose={noop}
      />,
    );

    // A write and an edit are the same event, so the rule that only a
    // successful call reads as applied has to hold for both.
    expect(getByText("Requested changes")).toBeDefined();
    expect(queryByText("Changes")).toBeNull();
  });

  test("shows a written file as content, not as an escaped JSON string", () => {
    const { getByText, queryByText } = render(
      <ToolDetailPanel
        detail={makeDetail({
          toolName: "file_write",
          input: {
            path: "src/a.ts",
            content: 'const greeting = "hi";\nexport default greeting;\n',
          },
          result: "Wrote 2 lines to src/a.ts",
        })}
        onClose={noop}
      />,
    );

    // The file reaches the panel inside the input bag, which is the one place
    // the generic body prints a string with its quotes and newlines escaped.
    expect(getByText("Changes")).toBeDefined();
    expect(getByText("src/a.ts")).toBeDefined();
    expect(queryByText(/\\n/)).toBeNull();
  });

  test("reads a bash command stored under the legacy cmd key", () => {
    const { getByText } = render(
      <ToolDetailPanel
        detail={makeDetail({
          toolName: "bash",
          input: { cmd: "git status --short" },
          result: "clean",
        })}
        onClose={noop}
      />,
    );

    expect(getByText("git status --short")).toBeDefined();
  });

  test("clicking close fires onClose", () => {
    const onClose = mock(() => {});
    const { getByLabelText } = render(
      <ToolDetailPanel detail={makeDetail()} onClose={onClose} />,
    );

    fireEvent.click(getByLabelText("Close tool details"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("copy button writes the content to the clipboard", () => {
    const { getAllByLabelText, getByText, queryAllByLabelText } = render(
      <ToolDetailPanel detail={makeDetail()} onClose={noop} />,
    );

    // Parameters and a structured output copy from their labels, and both raw
    // forms start closed, so at rest no block has a copy button. Opening the
    // raw input adds its own.
    expect(queryAllByLabelText("Copy")).toHaveLength(0);
    act(() => {
      fireEvent.click(getByText("Raw input"));
    });
    const copyButtons = getAllByLabelText("Copy");
    expect(copyButtons.length).toBe(1);

    fireEvent.click(copyButtons[0]!);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(
      JSON.stringify(
        { label: "toronto-location", role: "researcher" },
        null,
        2,
      ),
    );
  });

  describe("output laid out like input", () => {
    test("a JSON object result reads as fields, with the result as received under Raw output", () => {
      const result = '{"imported":3,"list":"Inbound"}';
      const { getByText, queryByText, getByLabelText } = render(
        <ToolDetailPanel detail={makeDetail({ result })} onClose={noop} />,
      );

      expect(getByText("imported")).toBeDefined();
      expect(getByText("Inbound")).toBeDefined();
      // The raw form starts closed and, once opened, is the text as received,
      // not a re-serialization of it.
      expect(queryByText(result)).toBeNull();
      act(() => {
        fireEvent.click(getByText("Raw output"));
      });
      expect(getByText(result).tagName).toBe("PRE");
      fireEvent.click(getByLabelText("Copy list"));
      expect(writeText).toHaveBeenCalledWith("Inbound");
    });

    test("a list of records at the root reads as a table with no label of its own", () => {
      const rows = [
        { week: "2026-08-03", users: 12840 },
        { week: "2026-08-10", users: 13217 },
      ];
      const { getAllByRole, getByText } = render(
        <ToolDetailPanel
          detail={makeDetail({ result: JSON.stringify(rows) })}
          onClose={noop}
        />,
      );

      expect(getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
        "week",
        "users",
      ]);
      expect(getByText("Raw output")).toBeDefined();
    });

    test("a result that is not JSON, or an empty object, stays a code block", () => {
      for (const result of ["Moved 3 files.", "{}", "[]", "42"]) {
        const { container, queryByText, unmount } = render(
          <ToolDetailPanel detail={makeDetail({ result })} onClose={noop} />,
        );
        expect(container.querySelector("pre")?.textContent).toBe(result);
        expect(queryByText("Raw output")).toBeNull();
        unmount();
      }
    });

    test("an error or a streamed tail reads as the text it is, whatever its shape", () => {
      const json = '{"error":"quota exceeded"}';
      for (const overrides of [
        { result: json, status: "error" as const },
        {
          result: undefined,
          streamedOutput: json,
          status: "running" as const,
        },
      ]) {
        const { container, queryByText, unmount } = render(
          <ToolDetailPanel detail={makeDetail(overrides)} onClose={noop} />,
        );
        expect(container.querySelector("pre")?.textContent).toBe(json);
        expect(queryByText("Raw output")).toBeNull();
        unmount();
      }
    });

    test("a renderer that owns its output keeps it, JSON or not", () => {
      const { container, queryByText } = render(
        <ToolDetailPanel
          detail={makeDetail({
            toolName: "bash",
            input: { command: "cat package.json" },
            result: '{"name":"app"}',
          })}
          onClose={noop}
        />,
      );

      expect(
        [...container.querySelectorAll("pre")].map((pre) => pre.textContent),
      ).toContain('{"name":"app"}');
      expect(queryByText("Raw output")).toBeNull();
    });

    test("counts what an output leaves out against Raw output", () => {
      const ids = Array.from({ length: 23 }, (_, index) => `id-${index + 1}`);
      const { getByText } = render(
        <ToolDetailPanel
          detail={makeDetail({ result: JSON.stringify({ ids }) })}
          onClose={noop}
        />,
      );

      expect(getByText("3 more in Raw output")).toBeDefined();
    });
  });

  test("thinking variant renders the reasoning markdown without input/output sections", () => {
    const detail = makeDetail({
      kind: "thinking",
      title: "Thinking",
      thinkingText: "I should first check the directory listing.",
    });
    const { getByText, queryByText } = render(
      <ToolDetailPanel detail={detail} onClose={noop} />,
    );

    // Title + full reasoning text are present.
    expect(getByText("Thinking")).toBeDefined();
    expect(
      getByText("I should first check the directory listing."),
    ).toBeDefined();
    // No tool sections.
    expect(queryByText("Technical details")).toBeNull();
    expect(queryByText("Output")).toBeNull();
    // No risk badge.
    expect(queryByText("Subagent Spawn")).toBeNull();
  });

  test("thinking variant close button fires onClose", () => {
    const onClose = mock(() => {});
    const detail = makeDetail({
      kind: "thinking",
      title: "Thinking",
      thinkingText: "Reasoning.",
    });
    const { getByLabelText } = render(
      <ToolDetailPanel detail={detail} onClose={onClose} />,
    );

    fireEvent.click(getByLabelText("Close tool details"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("thinking variant streams live reasoning from the chat-session store", () => {
    act(() => {
      useChatSessionStore.setState({
        snapshot: snap([
          {
            id: "m1",
            role: "assistant",
            contentBlocks: [{ type: "thinking", thinking: "live reasoning" }],
          },
        ] as DisplayMessage[]),
      });
    });
    const detail = makeDetail({
      kind: "thinking",
      title: "Thought process",
      messageId: "m1",
      thinkingGroupIndex: 0,
      thinkingText: "stale snapshot",
    });
    const { getByText, queryByText } = render(
      <ToolDetailPanel detail={detail} onClose={noop} />,
    );

    // The live store text wins over the open-time snapshot.
    expect(getByText("live reasoning")).toBeDefined();
    expect(queryByText("stale snapshot")).toBeNull();

    // Growing the store message updates the already-open drawer.
    act(() => {
      useChatSessionStore.setState({
        snapshot: snap([
          {
            id: "m1",
            role: "assistant",
            contentBlocks: [
              { type: "thinking", thinking: "live reasoning, extended" },
            ],
          },
        ] as DisplayMessage[]),
      });
    });
    expect(getByText("live reasoning, extended")).toBeDefined();
  });

  test("thinking variant falls back to the snapshot when the message is absent", () => {
    const detail = makeDetail({
      kind: "thinking",
      title: "Thought process",
      messageId: "missing",
      thinkingGroupIndex: 0,
      thinkingText: "snapshot fallback",
    });
    const { getByText } = render(
      <ToolDetailPanel detail={detail} onClose={noop} />,
    );
    expect(getByText("snapshot fallback")).toBeDefined();
  });

  test("thinking variant keeps the full reasoning from the committed snapshot", () => {
    // When a turn finishes, the committed row lives in the materialized
    // snapshot. The drawer must keep rendering the full reasoning resolved from
    // there, not snap back to the truncated open-time snapshot.
    seedHistory([
      {
        id: "m1",
        role: "assistant",
        contentBlocks: [
          { type: "thinking", thinking: "the full committed reasoning" },
        ],
      } as DisplayMessage,
    ]);
    const detail = makeDetail({
      kind: "thinking",
      title: "Thought process",
      messageId: "m1",
      thinkingGroupIndex: 0,
      thinkingText: "stale partial snapshot",
    });
    const { getByText, queryByText } = render(
      <ToolDetailPanel detail={detail} onClose={noop} />,
    );
    expect(getByText("the full committed reasoning")).toBeDefined();
    expect(queryByText("stale partial snapshot")).toBeNull();
  });

  test("thinking variant selects a single reasoning segment by item index", () => {
    act(() => {
      useChatSessionStore.setState({
        snapshot: snap([
          {
            id: "m1",
            role: "assistant",
            contentBlocks: [
              { type: "thinking", thinking: "segment one" },
              {
                type: "tool_use",
                toolCall: { id: "t1", name: "bash", input: {} },
              },
              { type: "thinking", thinking: "segment two" },
            ],
          },
        ] as DisplayMessage[]),
      });
    });
    const detail = makeDetail({
      kind: "thinking",
      title: "Thinking",
      messageId: "m1",
      thinkingGroupIndex: 0,
      thinkingItemIndex: 1,
      thinkingText: "ignored snapshot",
    });
    const { getByText, queryByText } = render(
      <ToolDetailPanel detail={detail} onClose={noop} />,
    );
    expect(getByText("segment two")).toBeDefined();
    expect(queryByText("segment one")).toBeNull();
  });
});
