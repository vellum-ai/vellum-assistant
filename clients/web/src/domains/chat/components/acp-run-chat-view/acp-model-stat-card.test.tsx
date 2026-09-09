/**
 * Tests for the read-only MODEL tile in the ACP run detail panel.
 *
 * Whether the tile renders at all is the panel's decision, so those cases live
 * in `acp-run-chat-view.test.tsx` beside the grid they size.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

import { AcpModelStatCard } from "./acp-model-stat-card";

afterEach(cleanup);

describe("AcpModelStatCard", () => {
  test("names the reported model under the Model label", () => {
    render(<AcpModelStatCard model="claude-opus-4-1-20250805" />);

    expect(screen.getByText("claude-opus-4-1-20250805")).toBeTruthy();
    expect(screen.getByText("Model")).toBeTruthy();
  });

  test("offers nothing to press", () => {
    const { container } = render(<AcpModelStatCard model="opus" />);

    expect(container.querySelector("button")).toBeNull();
  });
});
