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
  from: { address: "maya@example.com" },
  to: [{ address: "velly@example.org" }],
  subject: "Q4 vendor contract",
  createdAt: "2026-09-16T09:52:00Z",
};

/** A row that already carries its body, as the fixtures do. */
/** A copy the assistant sent, for the Sent folder. */
const SENT: InboxEmail = {
  id: "m-3",
  direction: "outbound",
  from: { name: "Velly", address: "velly@example.org" },
  to: [{ name: "Sam Okafor", address: "sam@example.com" }],
  subject: "Re: Dinner?",
  createdAt: "2026-09-14T11:30:00Z",
};

const CARRIED: InboxEmail = {
  id: "m-2",
  direction: "inbound",
  from: { name: "Sam Okafor", address: "sam@example.com" },
  to: [{ address: "velly@example.org" }],
  subject: "Dinner?",
  snippet: "Saturday works.",
  body: "Saturday works.\n\nSam",
  createdAt: "2026-09-14T11:08:00Z",
  attachments: [],
};

function renderPage(props: {
  inbox: InboxEmail[];
  sent?: InboxEmail[];
  loadDetail?: (email: InboxEmail) => Promise<EmailDetailData>;
  onStartChat?: (emails: InboxEmail[]) => void;
  onDeleteEmails?: (emails: InboxEmail[]) => void;
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
          address="velly@example.org"
          inbox={props.inbox}
          sent={props.sent ?? []}
          now={NOW}
          loadDetail={props.loadDetail}
          onStartChat={props.onStartChat}
          onDeleteEmails={props.onDeleteEmails}
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
    expect(screen.getByText("maya@example.com")).toBeTruthy();
    expect(screen.getAllByText("Q4 vendor contract").length).toBeGreaterThan(0);
    expect(screen.queryByText("Attaching the redline.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /maya@example.com/ }));

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

    fireEvent.click(screen.getByRole("button", { name: /maya@example.com/ }));

    await waitFor(() => {
      expect(screen.getByText("Couldn't load this message.")).toBeTruthy();
    });
  });

  test("rows offer no checkbox unless something acts on a selection", () => {
    renderPage({ inbox: [LISTED] });
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  test("checking rows raises the bar, and Start a new chat hands over the checked mail", () => {
    const started: InboxEmail[][] = [];
    renderPage({
      inbox: [LISTED, CARRIED],
      onStartChat: (emails) => started.push(emails),
    });
    expect(screen.queryByTestId("email-selection-bar")).toBeNull();

    fireEvent.click(
      screen.getByRole("checkbox", { name: 'Select "Q4 vendor contract"' }),
    );
    expect(screen.getByText("1 email selected")).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: 'Select "Dinner?"' }));
    expect(screen.getByText("2 emails selected")).toBeTruthy();

    // Unchecking narrows the count again.
    fireEvent.click(screen.getByRole("checkbox", { name: 'Select "Dinner?"' }));
    expect(screen.getByText("1 email selected")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Start a new chat" }));
    expect(started).toHaveLength(1);
    expect(started[0]!.map((email) => email.id)).toEqual(["m-1"]);
    // The selection is spent by the hand-off. (The bar's own exit is an
    // animation, so the state is read off the row rather than the bar.)
    expect(
      screen
        .getByRole("checkbox", { name: 'Select "Q4 vendor contract"' })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  test("checked mail survives the folder switch and the bar says which folder it came from", () => {
    renderPage({
      inbox: [LISTED],
      sent: [SENT],
      onStartChat: () => {},
    });

    fireEvent.click(
      screen.getByRole("checkbox", { name: 'Select "Q4 vendor contract"' }),
    );
    // Radix tabs switch on the press, not the click.
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Sent" }));
    expect(screen.getByText("1 email selected")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("checkbox", { name: 'Select "Re: Dinner?"' }),
    );
    expect(screen.getByText("2 emails selected")).toBeTruthy();
    expect(screen.getByText("1 received · 1 sent")).toBeTruthy();
  });

  test("Delete asks first, then hands over the checked mail and clears the selection", () => {
    const deleted: InboxEmail[][] = [];
    renderPage({
      inbox: [LISTED, CARRIED],
      onDeleteEmails: (emails) => deleted.push(emails),
    });

    fireEvent.click(
      screen.getByRole("checkbox", { name: 'Select "Q4 vendor contract"' }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete from inbox" }));
    expect(screen.getByText("Delete this email?")).toBeTruthy();
    expect(deleted).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.map((email) => email.id)).toEqual(["m-1"]);
    expect(
      screen
        .getByRole("checkbox", { name: 'Select "Q4 vendor contract"' })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  test("clearing the selection lowers the bar", () => {
    renderPage({ inbox: [LISTED], onStartChat: () => {} });
    fireEvent.click(
      screen.getByRole("checkbox", { name: 'Select "Q4 vendor contract"' }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(
      screen
        .getByRole("checkbox", { name: 'Select "Q4 vendor contract"' })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  test("search narrows the folder to matching rows", () => {
    renderPage({ inbox: [LISTED, CARRIED] });

    fireEvent.change(
      screen.getByRole("textbox", { name: "Search this folder" }),
      {
        target: { value: "dinner" },
      },
    );

    expect(screen.queryByText("maya@example.com")).toBeNull();
    expect(screen.getByText("Sam Okafor")).toBeTruthy();
  });
});
