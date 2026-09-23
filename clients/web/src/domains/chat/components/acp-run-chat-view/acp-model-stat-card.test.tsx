/**
 * Tests for the read-only MODEL tile in the ACP run detail panel.
 *
 * Whether the tile renders at all is the panel's decision, so those cases live
 * in `acp-run-chat-view.test.tsx` beside the grid they size.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

import type { AcpModelOption } from "@/domains/chat/acp-run-store";

import { AcpModelStatCard } from "./acp-model-stat-card";

const OPTIONS: AcpModelOption[] = [
  { value: "best", label: "Best available" },
  { value: "opus", label: "Opus" },
];

afterEach(cleanup);

describe("AcpModelStatCard", () => {
  test("names the reported model under the Model label", () => {
    render(<AcpModelStatCard model="claude-opus-4-1-20250805" />);

    expect(screen.getByText("claude-opus-4-1-20250805")).toBeTruthy();
    expect(screen.getByText("Model")).toBeTruthy();
  });

  // A model id is longer than the tile, which cuts it. The value carries its
  // own text as a tooltip, so the rest stays readable.
  test("keeps the whole id readable when the tile cuts it", () => {
    render(<AcpModelStatCard model="claude-opus-4-1-20250805" />);

    const value = screen.getByText("claude-opus-4-1-20250805");
    expect(value.getAttribute("title")).toBe("claude-opus-4-1-20250805");
  });

  // The adapter's own vocabulary: `best` is an alias it names for the reader,
  // and a value it never advertised is shown as the daemon reported it.
  test("names a model the adapter advertises by the adapter's label", () => {
    render(<AcpModelStatCard model="best" options={OPTIONS} />);

    expect(screen.getByText("Best available")).toBeTruthy();
    expect(screen.queryByText("best")).toBeNull();
  });

  test("shows the wire value for a model no option names", () => {
    render(<AcpModelStatCard model="haiku" options={OPTIONS} />);

    expect(screen.getByText("haiku")).toBeTruthy();
  });

  test("offers nothing to press", () => {
    const { container } = render(<AcpModelStatCard model="opus" />);

    expect(container.querySelector("button")).toBeNull();
  });
});
