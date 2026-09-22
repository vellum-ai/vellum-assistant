import { afterEach, describe, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

import { avatarQueryKey } from "@/hooks/use-assistant-avatar";

import type { EmailDetailData, InboxEmail } from "../types";
import { AssistantInboxPage } from "./assistant-inbox-page";

const ASSISTANT_ID = "asst-test";
const NOW = new Date("2026-09-16T15:40:00");

/** A row as the platform's list returns it: no preview, body, or attachments. */
const LISTED: InboxEmail = {
  id: "m-1",
  direction: "inbound",
  from: { address: "maya@northwind.co" },
  to: [{ address: "hi@velly.vellum.me" }],
  subject: "Q4 vendor contract",
  createdAt: "2026-09-16T09:52:00Z",
};

/** A row that already carries its body, as the fixtures do. */
const CARRIED: InboxEmail = {
  id: "m-2",
  direction: "inbound",
  from: { name: "Sam Okafor", address: "sam@example.com" },
  to: [{ address: "hi@velly.vellum.me" }],
  subject: "Dinner?",
  snippet: "Saturday works.",
  body: "Saturday works.\n\nSam",
  createdAt: "2026-09-14T11:08:00Z",
  attachments: [],
};

function renderPage(props: {
  inbox: InboxEmail[];
  loadDetail?: (email: InboxEmail) => Promise<EmailDetailData>;
}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  for (const supportsManifest of [true, false]) {
    client.setQueryData([...avatarQueryKey(ASSISTANT_ID), supportsManifest], {
      components: null,
      traits: null,
      customImageUrl: null,
    });
  }
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AssistantInboxPage
          assistantId={ASSISTANT_ID}
          assistantName="Velly"
          address="hi@velly.vellum.me"
          inbox={props.inbox}
          sent={[]}
          now={NOW}
          loadDetail={props.loadDetail}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("AssistantInboxPage", () => {
  test("a listed row draws two lines and fetches its body when opened", async () => {
    const calls: string[] = [];
    renderPage({
      inbox: [LISTED],
      loadDetail: async (email) => {
        calls.push(email.id);
        return {
          body: "Attaching the redline.\n\nMaya",
          attachments: [
            {
              id: "a-1",
              filename: "redline.pdf",
              contentType: "application/pdf",
              sizeBytes: 2048,
            },
          ],
        };
      },
    });

    // Sender line and subject, and nothing where a preview would be.
    expect(screen.getByText("maya@northwind.co")).toBeTruthy();
    expect(screen.getAllByText("Q4 vendor contract").length).toBeGreaterThan(0);
    expect(screen.queryByText("Attaching the redline.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /maya@northwind.co/ }));

    await waitFor(() => {
      expect(screen.getByText("Attaching the redline.")).toBeTruthy();
    });
    expect(calls).toEqual(["m-1"]);
    expect(screen.getByText("redline.pdf")).toBeTruthy();
  });

  test("a row that carries its body never asks the loader", async () => {
    const calls: string[] = [];
    renderPage({
      inbox: [CARRIED],
      loadDetail: async (email) => {
        calls.push(email.id);
        return { body: "should not be used", attachments: [] };
      },
    });

    fireEvent.click(screen.getByRole("button", { name: /Sam Okafor/ }));

    await waitFor(() => {
      expect(screen.getByText("Sam")).toBeTruthy();
    });
    expect(calls).toEqual([]);
    expect(screen.queryByText("should not be used")).toBeNull();
  });

  test("a failed fetch reports instead of showing a stale body", async () => {
    renderPage({
      inbox: [LISTED],
      loadDetail: async () => {
        throw new Error("boom");
      },
    });

    fireEvent.click(screen.getByRole("button", { name: /maya@northwind.co/ }));

    await waitFor(() => {
      expect(screen.getByText("Couldn't load this message.")).toBeTruthy();
    });
  });

  test("search narrows the folder to matching rows", () => {
    renderPage({ inbox: [LISTED, CARRIED] });

    fireEvent.change(
      screen.getByRole("textbox", { name: "Search this folder" }),
      {
        target: { value: "dinner" },
      },
    );

    expect(screen.queryByText("maya@northwind.co")).toBeNull();
    expect(screen.getByText("Sam Okafor")).toBeTruthy();
  });
});
