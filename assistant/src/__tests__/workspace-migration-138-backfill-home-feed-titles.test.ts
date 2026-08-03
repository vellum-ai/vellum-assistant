/**
 * Tests for workspace migration `138-backfill-home-feed-titles`.
 *
 * The migration gives every item in `<workspace>/data/home-feed.json` a
 * non-empty `title`, derived from the item's own `summary` when the
 * field is missing or blank.
 *
 * Cases covered:
 *   1. Missing file, malformed JSON, and a non-object root are no-ops.
 *   2. Title-less items gain a first-sentence title from the summary.
 *   3. Items that already have a title are untouched.
 *   4. A long summary truncates to 60 characters with an ellipsis, the
 *      same cap the notification pipeline's derivation applies.
 *   5. Markdown-rich and multi-line summaries yield a single line of
 *      plain text.
 *   6. `version`, `updatedAt`, and unrelated item fields are preserved.
 *   7. A second run writes nothing.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { backfillHomeFeedTitlesMigration } from "../workspace/migrations/138-backfill-home-feed-titles.js";
import { WORKSPACE_MIGRATIONS } from "../workspace/migrations/registry.js";
import { getLastWorkspaceMigrationId } from "../workspace/migrations/runner.js";

let workspaceDir: string;
let feedPath: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-migration-138-test-"));
  feedPath = join(workspaceDir, "data", "home-feed.json");
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

function writeFeedFile(contents: unknown): void {
  mkdirSync(join(workspaceDir, "data"), { recursive: true });
  writeFileSync(feedPath, JSON.stringify(contents, null, 2), "utf-8");
}

function readFeedFile(): {
  version: number;
  items: Array<Record<string, unknown>>;
  updatedAt: string;
} {
  return JSON.parse(readFileSync(feedPath, "utf-8"));
}

function makeItem(
  overrides: Record<string, unknown> & { id: string },
): Record<string, unknown> {
  return {
    type: "notification",
    priority: 50,
    summary: "Something happened.",
    timestamp: "2026-08-01T12:00:00.000Z",
    status: "new",
    createdAt: "2026-08-01T12:00:00.000Z",
    ...overrides,
  };
}

function writeFeed(items: Array<Record<string, unknown>>): void {
  writeFeedFile({
    version: 2,
    updatedAt: "2026-08-01T12:00:00.000Z",
    items,
  });
}

describe("workspace migration 138-backfill-home-feed-titles", () => {
  test("has the expected id and description", () => {
    expect(backfillHomeFeedTitlesMigration.id).toBe(
      "138-backfill-home-feed-titles",
    );
    expect(backfillHomeFeedTitlesMigration.description).toContain("title");
  });

  // getLastWorkspaceMigrationId() reports the final array entry as the
  // registry ceiling to the identity and rollback routes, so the
  // highest-numbered migration must sit last in the registry.
  test("the registry ceiling stays at the highest-numbered migration", () => {
    const numericId = (id: string) => Number.parseInt(id, 10);
    const highest = Math.max(
      ...WORKSPACE_MIGRATIONS.map((m) => numericId(m.id)).filter(
        Number.isFinite,
      ),
    );
    const last = getLastWorkspaceMigrationId(WORKSPACE_MIGRATIONS);
    expect(last).not.toBeNull();
    expect(numericId(last!)).toBe(highest);
  });

  test("missing file is a no-op (no error, no file created)", () => {
    expect(existsSync(feedPath)).toBe(false);

    expect(() =>
      backfillHomeFeedTitlesMigration.run(workspaceDir),
    ).not.toThrow();

    expect(existsSync(feedPath)).toBe(false);
  });

  test("derives a title from the summary's first sentence", () => {
    writeFeed([
      makeItem({
        id: "a-1",
        summary: "Alice replied to your thread. She needs an answer.",
      }),
      makeItem({ id: "a-2", summary: "Deploy finished!" }),
      makeItem({ id: "a-3", summary: "Ready to review? The draft is up." }),
    ]);

    backfillHomeFeedTitlesMigration.run(workspaceDir);

    const titles = readFeedFile().items.map((item) => item.title);
    expect(titles).toEqual([
      "Alice replied to your thread.",
      "Deploy finished!",
      "Ready to review?",
    ]);
  });

  test("backfills items whose title is missing, empty, blank, or not a string", () => {
    writeFeed([
      makeItem({ id: "missing", summary: "First item summary." }),
      makeItem({ id: "empty", title: "", summary: "Second item summary." }),
      makeItem({ id: "blank", title: "   ", summary: "Third item summary." }),
      makeItem({ id: "wrong-type", title: null, summary: "Fourth summary." }),
    ]);

    backfillHomeFeedTitlesMigration.run(workspaceDir);

    const titles = readFeedFile().items.map((item) => item.title);
    expect(titles).toEqual([
      "First item summary.",
      "Second item summary.",
      "Third item summary.",
      "Fourth summary.",
    ]);
  });

  test("leaves items that already have a title untouched", () => {
    writeFeed([
      makeItem({
        id: "titled",
        title: "Existing headline",
        summary: "A completely different summary sentence.",
      }),
      makeItem({ id: "untitled", summary: "Needs a headline." }),
    ]);

    backfillHomeFeedTitlesMigration.run(workspaceDir);

    const items = readFeedFile().items;
    expect(items[0]!.title).toBe("Existing headline");
    expect(items[1]!.title).toBe("Needs a headline.");
  });

  test("truncates a long summary to 60 characters with an ellipsis", () => {
    const summary =
      "Bob shared a very long document that keeps going well past the limit";
    writeFeed([makeItem({ id: "long", summary })]);

    backfillHomeFeedTitlesMigration.run(workspaceDir);

    const title = readFeedFile().items[0]!.title as string;
    expect(title).toBe(
      "Bob shared a very long document that keeps going well past t…",
    );
    // The ellipsis sits past the cap, so the retained text is exactly 60.
    expect(title.slice(0, -1).length).toBe(60);
  });

  test("truncates a long first sentence rather than the whole summary", () => {
    writeFeed([
      makeItem({
        id: "long-sentence",
        summary:
          "This opening sentence runs well beyond the sixty character cap on derived titles. Then another.",
      }),
    ]);

    backfillHomeFeedTitlesMigration.run(workspaceDir);

    const title = readFeedFile().items[0]!.title as string;
    expect(title).toBe(
      "This opening sentence runs well beyond the sixty character c…",
    );
  });

  test("flattens a markdown-rich multi-line summary into one plain line", () => {
    writeFeed([
      makeItem({
        id: "markdown",
        summary:
          "## Nightly run\n\n- **Deploy** finished\n- Tests passed\n\nSee the `report` for details.",
      }),
    ]);

    backfillHomeFeedTitlesMigration.run(workspaceDir);

    expect(readFeedFile().items[0]!.title).toBe(
      "Nightly run Deploy finished Tests passed See the report for…",
    );
  });

  test("unwraps inline markdown before taking the first sentence", () => {
    writeFeed([
      makeItem({
        id: "inline",
        summary:
          "**Alice** shared the [design doc](https://example.com/doc). Review it soon.",
      }),
    ]);

    backfillHomeFeedTitlesMigration.run(workspaceDir);

    expect(readFeedFile().items[0]!.title).toBe("Alice shared the design doc.");
  });

  test("collapses a newline-only summary run into single spaces", () => {
    writeFeed([
      makeItem({ id: "newlines", summary: "Backup complete\n\nNo errors" }),
    ]);

    backfillHomeFeedTitlesMigration.run(workspaceDir);

    expect(readFeedFile().items[0]!.title).toBe("Backup complete No errors");
  });

  test("skips an item whose summary is markdown structure only", () => {
    writeFeed([makeItem({ id: "structure-only", summary: "##\n\n- \n\n> " })]);

    backfillHomeFeedTitlesMigration.run(workspaceDir);

    expect(readFeedFile().items[0]!.title).toBeUndefined();
  });

  test("preserves version, updatedAt, and unrelated item fields", () => {
    writeFeedFile({
      version: 2,
      updatedAt: "2026-08-01T12:00:00.000Z",
      items: [
        makeItem({
          id: "keep-fields",
          summary: "Payment failed.",
          urgency: "high",
          conversationId: "conv-abc",
          actions: [{ label: "Retry", kind: "prompt" }],
          detailPanel: { kind: "text", body: "Details" },
        }),
      ],
    });

    backfillHomeFeedTitlesMigration.run(workspaceDir);

    const out = readFeedFile();
    expect(out.version).toBe(2);
    expect(out.updatedAt).toBe("2026-08-01T12:00:00.000Z");

    const item = out.items[0]!;
    expect(item.title).toBe("Payment failed.");
    expect(item.id).toBe("keep-fields");
    expect(item.type).toBe("notification");
    expect(item.priority).toBe(50);
    expect(item.status).toBe("new");
    expect(item.urgency).toBe("high");
    expect(item.conversationId).toBe("conv-abc");
    expect(item.actions).toEqual([{ label: "Retry", kind: "prompt" }]);
    expect(item.detailPanel).toEqual({ kind: "text", body: "Details" });
  });

  test("idempotent: a second run writes nothing", () => {
    writeFeed([
      makeItem({ id: "a-1", summary: "Alice replied to your thread." }),
      makeItem({ id: "a-2", title: "Already titled", summary: "Body text." }),
    ]);

    backfillHomeFeedTitlesMigration.run(workspaceDir);
    const afterFirst = readFileSync(feedPath, "utf-8");
    const afterFirstStat = statSync(feedPath);

    backfillHomeFeedTitlesMigration.run(workspaceDir);

    expect(readFileSync(feedPath, "utf-8")).toBe(afterFirst);
    expect(statSync(feedPath).mtimeMs).toBe(afterFirstStat.mtimeMs);
  });

  test("a fully titled feed is left byte-identical", () => {
    writeFeed([makeItem({ id: "a-1", title: "Titled", summary: "Body." })]);
    const before = readFileSync(feedPath, "utf-8");
    const beforeStat = statSync(feedPath);

    backfillHomeFeedTitlesMigration.run(workspaceDir);

    expect(readFileSync(feedPath, "utf-8")).toBe(before);
    expect(statSync(feedPath).mtimeMs).toBe(beforeStat.mtimeMs);
  });

  test("malformed JSON does not throw and leaves the file alone", () => {
    mkdirSync(join(workspaceDir, "data"), { recursive: true });
    writeFileSync(feedPath, "{not valid json", "utf-8");
    const before = readFileSync(feedPath, "utf-8");

    expect(() =>
      backfillHomeFeedTitlesMigration.run(workspaceDir),
    ).not.toThrow();

    expect(readFileSync(feedPath, "utf-8")).toBe(before);
  });

  test("non-object root is a no-op", () => {
    writeFeedFile([1, 2, 3]);
    const before = readFileSync(feedPath, "utf-8");

    expect(() =>
      backfillHomeFeedTitlesMigration.run(workspaceDir),
    ).not.toThrow();

    expect(readFileSync(feedPath, "utf-8")).toBe(before);
  });

  test("items that cannot yield a title are skipped without throwing", () => {
    writeFeedFile({
      version: 2,
      updatedAt: "2026-08-01T12:00:00.000Z",
      items: [
        "not an object",
        makeItem({ id: "no-summary", summary: undefined }),
        makeItem({ id: "blank-summary", summary: "   " }),
        makeItem({ id: "ok", summary: "Has a summary." }),
      ],
    });

    expect(() =>
      backfillHomeFeedTitlesMigration.run(workspaceDir),
    ).not.toThrow();

    const items: unknown[] = readFeedFile().items;
    expect(items[0]).toBe("not an object");
    expect((items[1] as Record<string, unknown>).title).toBeUndefined();
    expect((items[2] as Record<string, unknown>).title).toBeUndefined();
    expect((items[3] as Record<string, unknown>).title).toBe("Has a summary.");
  });

  test("down() is a no-op (forward-only migration)", () => {
    writeFeed([makeItem({ id: "a-1", summary: "Alice replied." })]);
    backfillHomeFeedTitlesMigration.run(workspaceDir);
    const after = readFileSync(feedPath, "utf-8");

    expect(() =>
      backfillHomeFeedTitlesMigration.down(workspaceDir),
    ).not.toThrow();

    expect(readFileSync(feedPath, "utf-8")).toBe(after);
  });
});
