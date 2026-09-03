/**
 * The modal's own behaviour: which row is open, what a launch does to the
 * accordion, and what each variant offers as a way out.
 *
 * Mocked at the transport, not at the seams. `mock.module` replaces a module
 * for every test file sharing the process, so stubbing the launch hook here
 * would erase the real one for its own test file, and stubbing
 * `conversation-navigation` would do the same to the settings surfaces that
 * mock it. Stubbing `fetch` and reading the router costs a little more setup
 * and reaches further: the assertions below see the prompt that actually goes
 * on the wire.
 */

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";

import {
  ACTIVATION_PROGRESS_ALL_DONE,
  ACTIVATION_PROGRESS_EMPTY,
  ACTIVATION_PROGRESS_ONE_WORKING,
  FIXTURE_STARTER_IDS,
} from "@/domains/activation/activation-test-fixtures";
import { useActivationUiStore } from "@/domains/activation/activation-ui-store";
import { getActivationList } from "@/domains/activation/catalog";
import { ActivationWelcomeModal } from "@/domains/activation/components/activation-welcome-modal";
import type { ActivationProgress } from "@/domains/activation/hooks/use-activation-progress";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

const { starters, items } = getActivationList("smb");
const ASSISTANT_ID = "asst-1";

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

const requests: CapturedRequest[] = [];
const originalFetch = globalThis.fetch;
let startStatus = 200;

/** The prompt bodies that reached `POST /v1/messages`. */
function sentPrompts(): unknown[] {
  return requests
    .filter((request) => request.url.includes("/messages"))
    .map((request) => request.body.message ?? request.body.content);
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetch(): void {
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    let bodyText: string | undefined;
    if (input instanceof Request) {
      bodyText = await input.clone().text();
    } else if (typeof init?.body === "string") {
      bodyText = init.body;
    }
    requests.push({
      url,
      body: bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {},
    });
    if (url.includes("/messages")) {
      return json({
        accepted: true,
        messageId: "m1",
        conversationId: "conv-1",
      });
    }
    if (url.includes("/activation/tasks/")) {
      if (startStatus !== 200) {
        return new Response(JSON.stringify({ detail: "task id rejected" }), {
          status: startStatus,
          headers: { "Content-Type": "application/json" },
        });
      }
      return json({ taskId: "t", status: "started" });
    }
    if (url.includes("/conversations")) {
      return json({
        id: "conv-1",
        conversationKey: "",
        conversationType: "standard",
        created: true,
      });
    }
    return json({});
  }) as typeof fetch;
}

/** Reads the address back so navigation can be asserted without a mock. */
function LocationProbe(): ReactNode {
  return <span data-testid="location">{useLocation().pathname}</span>;
}

function renderModal(
  progress: ActivationProgress,
  variant: "welcome" | "all-done" = "welcome",
  onDismiss: () => void = () => {},
): ReturnType<typeof render> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/assistant/conversation/c0"]}>
        <LocationProbe />
        <ActivationWelcomeModal
          open
          listId="smb"
          progress={progress}
          variant={variant}
          onDismiss={onDismiss}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  requests.length = 0;
  startStatus = 200;
  installFetch();
  useResolvedAssistantsStore.setState({ activeAssistantId: ASSISTANT_ID });
  useActivationUiStore.setState({
    expandedTaskId: null,
    showMore: false,
    modalReopened: false,
  });
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("ActivationWelcomeModal", () => {
  test("opens the first unstarted starter and only that one", () => {
    const { queryAllByLabelText } = renderModal(ACTIVATION_PROGRESS_EMPTY);
    expect(useActivationUiStore.getState().expandedTaskId).toBe(
      FIXTURE_STARTER_IDS[0],
    );
    expect(queryAllByLabelText("Custom:")).toHaveLength(1);
  });

  test("opening another row closes the one that was open", () => {
    const { getByText, queryAllByLabelText } = renderModal(
      ACTIVATION_PROGRESS_EMPTY,
    );
    fireEvent.click(getByText(starters[1]!.title));
    expect(useActivationUiStore.getState().expandedTaskId).toBe(
      FIXTURE_STARTER_IDS[1],
    );
    expect(queryAllByLabelText("Custom:")).toHaveLength(1);
  });

  test("skips a started task when it seeds the open row", () => {
    renderModal(ACTIVATION_PROGRESS_ONE_WORKING);
    expect(useActivationUiStore.getState().expandedTaskId).toBe(
      FIXTURE_STARTER_IDS[1],
    );
  });

  test("the chip sends the task's catalog prompt", async () => {
    const { getByText } = renderModal(ACTIVATION_PROGRESS_EMPTY);
    await act(async () => {
      fireEvent.click(getByText(starters[0]!.chip));
    });
    expect(sentPrompts()).toEqual([starters[0]!.prompt]);
  });

  test("the chip links the task before it sends anything", async () => {
    const { getByText } = renderModal(ACTIVATION_PROGRESS_EMPTY);
    await act(async () => {
      fireEvent.click(getByText(starters[0]!.chip));
    });
    const start = requests.find((request) =>
      request.url.includes(`/activation/tasks/${FIXTURE_STARTER_IDS[0]}/start`),
    );
    expect(start?.body).toEqual({ conversationId: "conv-1", listId: "smb" });
  });

  test("the Custom field sends the typed prompt instead", async () => {
    const { getByLabelText, getByRole } = renderModal(
      ACTIVATION_PROGRESS_EMPTY,
    );
    fireEvent.change(getByLabelText("Custom:"), {
      target: { value: "quote for Acme" },
    });
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Send" }));
    });
    expect(sentPrompts()).toEqual(["quote for Acme"]);
  });

  /**
   * A prompt sent against a task the daemon has no link for would run work the
   * checklist can never observe, so a refused link has to stop the send.
   */
  test("a refused link sends no prompt", async () => {
    startStatus = 400;
    const { getByText } = renderModal(ACTIVATION_PROGRESS_EMPTY);
    await act(async () => {
      fireEvent.click(getByText(starters[0]!.chip));
    });
    expect(sentPrompts()).toEqual([]);
  });

  test("a launch moves the accordion on to the next unstarted row", () => {
    const { getByText } = renderModal(ACTIVATION_PROGRESS_EMPTY);
    fireEvent.click(getByText(starters[0]!.chip));
    expect(useActivationUiStore.getState().expandedTaskId).toBe(
      FIXTURE_STARTER_IDS[1],
    );
  });

  test("Show More counts the rest of the catalog and opens it inline", () => {
    const { getByRole, getByText } = renderModal(ACTIVATION_PROGRESS_EMPTY);
    fireEvent.click(
      getByRole("button", { name: `Show More (${items.length})` }),
    );
    expect(useActivationUiStore.getState().showMore).toBe(true);
    expect(getByText(items[0]!.title)).not.toBeNull();
  });

  test("Do it Later dismisses", () => {
    let dismissals = 0;
    const { getByRole } = renderModal(
      ACTIVATION_PROGRESS_EMPTY,
      "welcome",
      () => {
        dismissals += 1;
      },
    );
    fireEvent.click(getByRole("button", { name: "Do it Later" }));
    expect(dismissals).toBe(1);
  });

  test("clicking a finished row opens its conversation", () => {
    const { getByRole, getByTestId } = renderModal(
      ACTIVATION_PROGRESS_ALL_DONE,
      "all-done",
    );
    fireEvent.click(
      getByRole("button", { name: `Open ${starters[0]!.title}` }),
    );
    expect(getByTestId("location").textContent).toContain("conv-done-1");
  });

  test("the celebration offers the full list instead of a way to put it off", () => {
    const { getByRole, queryByRole } = renderModal(
      ACTIVATION_PROGRESS_ALL_DONE,
      "all-done",
    );
    expect(queryByRole("button", { name: "Do it Later" })).toBeNull();
    expect(
      getByRole("button", { name: "Show me the full list" }),
    ).not.toBeNull();
  });

  test("the celebration navigates to the list and closes", () => {
    let dismissals = 0;
    const { getByRole, getByTestId } = renderModal(
      ACTIVATION_PROGRESS_ALL_DONE,
      "all-done",
      () => {
        dismissals += 1;
      },
    );
    fireEvent.click(getByRole("button", { name: "Show me the full list" }));
    expect(dismissals).toBe(1);
    expect(getByTestId("location").textContent).toBe("/assistant/suggestions");
  });
});
