import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import type { EmailReference } from "@/types/email-reference";

import { MessageEmailReferences } from "./message-email-references";

const RECEIVED: EmailReference = {
  id: "msg in 1",
  direction: "inbound",
  from: { name: "Maya Chen", address: "maya@example.com" },
  to: [{ address: "velly@example.org" }],
  subject: "Q4 vendor contract",
  createdAt: "2026-09-16T09:52:00Z",
};

const SENT: EmailReference = {
  id: "msg_out_1",
  direction: "outbound",
  from: { address: "velly@example.org" },
  to: [{ name: "Sam Okafor", address: "sam@example.com" }],
  subject: "",
  createdAt: "2026-09-12T18:04:00Z",
};

afterEach(() => {
  cleanup();
});

describe("MessageEmailReferences", () => {
  test("draws one card per email, each a link to its message in the inbox", () => {
    render(
      <MemoryRouter>
        <MessageEmailReferences emails={[RECEIVED, SENT]} />
      </MemoryRouter>,
    );

    const received = screen.getByRole("link", {
      name: "Open email Q4 vendor contract in the inbox",
    });
    expect(received.getAttribute("href")).toBe(
      "/assistant/inbox?folder=received&message=msg%20in%201",
    );
    expect(received.textContent).toContain("Received · From Maya Chen");

    const sent = screen.getByRole("link", {
      name: "Open email (no subject) in the inbox",
    });
    expect(sent.getAttribute("href")).toBe(
      "/assistant/inbox?folder=sent&message=msg_out_1",
    );
    expect(sent.textContent).toContain("Sent · To Sam Okafor");
  });

  test("renders nothing for no emails", () => {
    const { container } = render(
      <MemoryRouter>
        <MessageEmailReferences emails={[]} />
      </MemoryRouter>,
    );
    expect(container.textContent).toBe("");
  });
});
