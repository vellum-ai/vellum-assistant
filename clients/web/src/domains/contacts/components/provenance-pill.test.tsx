import { describe, expect, it } from "bun:test";

import type { ReactElement } from "react";

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { ProvenancePill } from "./provenance-pill";

function renderPill(ui: ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("ProvenancePill", () => {
  it("renders the global-default state", () => {
    renderPill(<ProvenancePill provenance={{ source: "global-default" }} />);
    expect(screen.getByText("Global default")).toBeTruthy();
  });

  it("renders the channel-default state with a link to the channel sub-tab", () => {
    renderPill(
      <ProvenancePill
        provenance={{ source: "channel-default", channel: "slack" }}
      />,
    );
    expect(screen.getByText(/Default from/)).toBeTruthy();
    const link = screen.getByRole("link", { name: "Channels → Slack" });
    expect(link.getAttribute("href")).toBe("/assistant/channels?setup=slack");
  });

  it("labels the linked channel per the channel presentation registry", () => {
    renderPill(
      <ProvenancePill
        provenance={{ source: "channel-default", channel: "telegram" }}
      />,
    );
    const link = screen.getByRole("link", { name: "Channels → Telegram" });
    expect(link.getAttribute("href")).toBe(
      "/assistant/channels?setup=telegram",
    );
  });
});
