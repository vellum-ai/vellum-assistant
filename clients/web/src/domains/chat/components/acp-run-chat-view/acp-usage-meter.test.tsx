import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

import { type AcpRunEntry } from "@/domains/chat/acp-run-store";

import { AcpUsageMeter } from "./acp-usage-meter";

afterEach(cleanup);

function entry(overrides: Partial<AcpRunEntry> = {}): AcpRunEntry {
  return {
    acpSessionId: "acp-1",
    agent: "claude",
    parentConversationId: "conv-1",
    status: "completed",
    startedAt: 0,
    usedTokens: 0,
    contextSize: 0,
    events: [],
    ...overrides,
  };
}

function statValue(label: string): string | undefined {
  return document
    .querySelector(`[data-usage-stat="${label}"]`)
    ?.textContent?.replace(/^[A-Za-z]+/, "");
}

describe("AcpUsageMeter", () => {
  test("shows only Input and Output when no cost is reported", () => {
    render(<AcpUsageMeter entry={entry({ inputTokens: 12000, outputTokens: 3400 })} />);

    expect(screen.getByTestId("acp-usage-meter")).toBeDefined();
    expect(statValue("input")).toBe("12,000");
    expect(statValue("output")).toBe("3,400");
    // No third stat: input+output is not the run total for reasoning runs, so
    // we don't label a sum as "Total".
    expect(statValue("total")).toBeUndefined();
    expect(statValue("cost")).toBeUndefined();
  });

  test("replaces Total with the run's actual cost when reported", () => {
    render(
      <AcpUsageMeter
        entry={entry({
          inputTokens: 12000,
          outputTokens: 3400,
          costAmount: 1.23,
          costCurrency: "USD",
        })}
      />,
    );

    expect(statValue("input")).toBe("12,000");
    expect(statValue("output")).toBe("3,400");
    expect(statValue("cost")).toBe("$1.23");
    expect(statValue("total")).toBeUndefined();
  });

  test("renders a sub-cent cost as a less-than-one-cent form", () => {
    render(
      <AcpUsageMeter
        entry={entry({
          inputTokens: 10,
          outputTokens: 5,
          costAmount: 0.004,
          costCurrency: "USD",
        })}
      />,
    );

    expect(statValue("cost")).toBe("<$0.01");
  });

  test("treats a missing side as zero when the other is present", () => {
    render(<AcpUsageMeter entry={entry({ inputTokens: 5000 })} />);

    expect(statValue("input")).toBe("5,000");
    expect(statValue("output")).toBe("0");
    expect(statValue("total")).toBeUndefined();
  });

  test("renders nothing when both input and output are absent", () => {
    const { container } = render(<AcpUsageMeter entry={entry()} />);
    expect(container.firstChild).toBeNull();
  });
});
