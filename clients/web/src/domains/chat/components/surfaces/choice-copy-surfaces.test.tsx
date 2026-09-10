import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

// Records the assistant id the surface threads through, so the router → surface
// wiring for workspace file references is assertable without the real renderer.
mock.module("@/domains/chat/components/chat-markdown-message", () => ({
  ChatMarkdownMessage: ({
    content,
    assistantId,
  }: {
    content: string;
    assistantId?: string | null;
  }) => (
    <div data-testid="markdown" data-assistant-id={assistantId ?? ""}>
      {content}
    </div>
  ),
}));

// Keep the platform-id resolution deterministic: the surface resolves the
// assistant's platform id before invalidating the connections query, and the
// real resolver reaches into local-mode/gateway state.
mock.module("@/lib/local-platform-identity", () => ({
  resolveLocalAssistantPlatformIdentity: mock(async (id: string) => id),
}));

import { ChoiceSurface } from "@/domains/chat/components/surfaces/choice-surface";
import { CopyBlockSurface } from "@/domains/chat/components/surfaces/copy-block-surface";
import { OAuthConnectSurface } from "@/domains/chat/components/surfaces/oauth-connect-surface";
import { SurfaceRouter } from "@/domains/chat/components/surfaces/surface-router";
import type {
  UseManagedOAuthConnectOptions,
  UseManagedOAuthConnectResult,
} from "@/hooks/use-managed-oauth-connect";
import type { OAuthConnection } from "@/generated/api/types.gen";
import type { Surface } from "@/domains/chat/types/types";

afterAll(() => {
  mock.restore();
});

afterEach(() => {
  cleanup();
});

// The OAuth connect surface reads `useQueryClient()` to refresh the connections
// list after a successful connect, so its renders need a provider. The returned
// `invalidateQueries` spy lets tests assert the cache refresh (or its absence).
function renderWithQueryClient(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const invalidateQueries = mock(() => Promise.resolve());
  client.invalidateQueries = invalidateQueries as never;
  // `wrap` keeps the provider in place on a rerender: dropping it would remount
  // the card rather than re-render it, which is a different assertion.
  const wrap = (node: ReactElement) => (
    <QueryClientProvider client={client}>{node}</QueryClientProvider>
  );
  return { invalidateQueries, wrap, ...render(wrap(ui)) };
}

function makeSurface(overrides: Partial<Surface>): Surface {
  return {
    surfaceId: "surface-1",
    surfaceType: "choice",
    data: {},
    ...overrides,
  };
}

describe("ChoiceSurface", () => {
  test("highlights recommended options and commits single-select choices on click", () => {
    const onAction = mock(() => {});
    const { getByRole, getByText } = render(
      <ChoiceSurface
        surface={makeSurface({
          title: "Pick an outcome",
          data: {
            description: "Choose the best next move.",
            options: [
              {
                id: "inbox",
                title: "Clean up my inbox",
                description: "Archive noise and surface the important threads.",
                recommended: true,
                data: { outcome: "inbox_cleanup" },
              },
              { id: "calendar", title: "Plan my week" },
            ],
          },
        })}
        onAction={onAction}
      />,
    );

    expect(getByText("Recommended")).toBeTruthy();

    fireEvent.click(getByRole("button", { name: /clean up my inbox/i }));

    expect(onAction).toHaveBeenCalledWith("surface-1", "inbox", {
      choiceId: "inbox",
      choiceTitle: "Clean up my inbox",
      selectedIds: ["inbox"],
      selectedTitles: ["Clean up my inbox"],
      choiceDescription: "Archive noise and surface the important threads.",
      recommended: true,
      outcome: "inbox_cleanup",
    });
  });

  test("multi-select choices require an explicit submit action", () => {
    const onAction = mock(() => {});
    const { getByRole } = render(
      <ChoiceSurface
        surface={makeSurface({
          data: {
            selectionMode: "multiple",
            submitLabel: "Run these",
            options: [
              { id: "inbox", title: "Clean up my inbox" },
              { id: "calendar", title: "Plan my week" },
            ],
          },
        })}
        onAction={onAction}
      />,
    );

    const submit = getByRole("button", { name: /run these/i });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(getByRole("button", { name: /clean up my inbox/i }));
    fireEvent.click(getByRole("button", { name: /plan my week/i }));
    expect((submit as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(submit);

    expect(onAction).toHaveBeenCalledWith("surface-1", "submit", {
      selectedIds: ["inbox", "calendar"],
      selectedTitles: ["Clean up my inbox", "Plan my week"],
      choices: [
        { id: "inbox", title: "Clean up my inbox" },
        { id: "calendar", title: "Plan my week" },
      ],
    });
  });

  test("recommended multi-select options are auto-selected but can be deselected", () => {
    const onAction = mock(() => {});
    const { getByRole } = render(
      <ChoiceSurface
        surface={makeSurface({
          data: {
            selectionMode: "multiple",
            submitLabel: "Run these",
            options: [
              { id: "inbox", title: "Clean up my inbox", recommended: true },
              { id: "calendar", title: "Plan my week" },
            ],
          },
        })}
        onAction={onAction}
      />,
    );

    const recommended = getByRole("button", { name: /clean up my inbox/i });
    const submit = getByRole("button", { name: /run these/i });

    expect(recommended.getAttribute("aria-pressed")).toBe("true");
    expect(recommended.querySelector("svg")).not.toBeNull();
    expect((submit as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(recommended);
    expect(recommended.getAttribute("aria-pressed")).toBe("false");
    expect(recommended.querySelector("svg")).toBeNull();
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect(onAction).not.toHaveBeenCalled();
  });
});

describe("CopyBlockSurface", () => {
  test("renders a visible copy affordance for the block text", async () => {
    const writeText = mock(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const { getByRole, getByText } = render(
      <CopyBlockSurface
        surface={makeSurface({
          surfaceType: "copy_block",
          data: {
            label: "Port prompt",
            text: "Paste this into another assistant.",
          },
        })}
        onAction={() => {}}
      />,
    );

    expect(getByText("Paste this into another assistant.")).toBeTruthy();

    fireEvent.click(getByRole("button", { name: "Copy" }));

    // `handleCopy` awaits the clipboard write before flipping to "Copied", so
    // the label lands a microtask after `writeText` is called — both
    // assertions have to sit inside the same retry.
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        "Paste this into another assistant.",
      );
      expect(getByRole("button", { name: "Copied" })).toBeTruthy();
    });
  });
});

describe("OAuthConnectSurface", () => {
  const CONNECTION: OAuthConnection = {
    id: "conn-1",
    provider: "google",
    status: "ACTIVE",
    connected: true,
    account_label: "user@example.com",
    scopes_granted: ["gmail.readonly"],
    expires_at: null,
  } as OAuthConnection;

  /**
   * A stand-in for the connect flow. Tests drive `status` directly, which is
   * what the card actually renders from: the real hook derives it from the
   * connections list rather than from the authorization window.
   */
  function stubConnect(overrides: Partial<UseManagedOAuthConnectResult> = {}) {
    const connect = mock(() => {});
    const dismiss = mock(() => {});
    const options: UseManagedOAuthConnectOptions[] = [];
    const useConnect = (opts: UseManagedOAuthConnectOptions) => {
      options.push(opts);
      return {
        connect,
        dismiss,
        status: "idle" as const,
        connection: null,
        errorMessage: null,
        ...overrides,
      };
    };
    return { connect, dismiss, options, useConnect };
  }

  const OAUTH_SURFACE = {
    surfaceType: "oauth_connect" as const,
    title: "Connect Google",
    data: {
      providerKey: "google",
      displayName: "Google",
      description: "Connect Gmail for this task.",
      connectLabel: "Connect Google Account",
      requestedScopes: ["gmail.readonly"],
    },
  };

  test("starts the connect flow with the surface's provider and scopes", () => {
    const stub = stubConnect();
    const { getByRole } = renderWithQueryClient(
      <OAuthConnectSurface
        surface={makeSurface(OAUTH_SURFACE)}
        assistantId="assistant-1"
        assistantDisplayName="Assistant"
        useConnect={stub.useConnect}
        fetchProvider={async () => null}
        onAction={mock(() => {})}
      />,
    );

    fireEvent.click(getByRole("button", { name: "Connect" }));

    expect(stub.connect).toHaveBeenCalled();
    expect(stub.options[0]).toMatchObject({
      assistantId: "assistant-1",
      providerKey: "google",
      providerLabel: "Google",
      requestedScopes: ["gmail.readonly"],
    });
  });

  test("an observed connection submits the connect action once", async () => {
    const onAction =
      mock<
        (
          surfaceId: string,
          actionId: string,
          data?: Record<string, unknown>,
        ) => void
      >();
    const stub = stubConnect({ status: "connected", connection: CONNECTION });
    // A fresh inline `onAction` each render, as a parent that does not
    // memoize its callback would produce. That changes the reporting effect's
    // dependencies, which is what a resubmission guard has to survive.
    const card = () => (
      <OAuthConnectSurface
        surface={makeSurface({ ...OAUTH_SURFACE, surfaceId: "surface-once" })}
        assistantId="assistant-1"
        useConnect={stub.useConnect}
        fetchProvider={async () => null}
        onAction={(...args) => onAction(...args)}
      />
    );
    const { rerender, wrap } = renderWithQueryClient(card());

    await waitFor(() => {
      expect(onAction).toHaveBeenCalledWith("surface-once", "connect", {
        status: "connected",
        providerKey: "google",
        providerLabel: "Google",
        connectionId: "conn-1",
        accountLabel: "user@example.com",
        scopesGranted: ["gmail.readonly"],
      });
    });

    // A re-render must not resubmit: one authorization is one surface action.
    rerender(wrap(card()));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  test("two mounted copies of one surface report the connection once", async () => {
    // The transcript keeps its card while the voice room renders its own copy
    // of the same surface, and both read the one provider-keyed attempt.
    const onAction = mock(() => {});
    const stub = stubConnect({ status: "connected", connection: CONNECTION });
    const surface = makeSurface({ ...OAUTH_SURFACE, surfaceId: "surface-two" });

    renderWithQueryClient(
      <>
        <OAuthConnectSurface
          surface={surface}
          assistantId="assistant-1"
          useConnect={stub.useConnect}
          fetchProvider={async () => null}
          onAction={onAction}
        />
        <OAuthConnectSurface
          surface={surface}
          assistantId="assistant-1"
          useConnect={stub.useConnect}
          fetchProvider={async () => null}
          onAction={onAction}
        />
      </>,
    );

    await waitFor(() => expect(onAction).toHaveBeenCalled());
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  test("a card that unmounts releases its report claim", async () => {
    // A completed surface renders as a static summary, so this card mounting
    // again means the submission never took and reporting is the point.
    const onAction = mock(() => {});
    const stub = stubConnect({ status: "connected", connection: CONNECTION });
    const surface = makeSurface({
      ...OAUTH_SURFACE,
      surfaceId: "surface-retry",
    });
    const card = (
      <OAuthConnectSurface
        surface={surface}
        assistantId="assistant-1"
        useConnect={stub.useConnect}
        fetchProvider={async () => null}
        onAction={onAction}
      />
    );

    const first = renderWithQueryClient(card);
    await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
    first.unmount();

    renderWithQueryClient(card);
    await waitFor(() => expect(onAction).toHaveBeenCalledTimes(2));
  });

  test("dismiss stays available while an authorization is open", () => {
    const onAction = mock(() => {});
    const stub = stubConnect({ status: "attempting" });
    const { getByRole } = renderWithQueryClient(
      <OAuthConnectSurface
        surface={makeSurface(OAUTH_SURFACE)}
        assistantId="assistant-1"
        useConnect={stub.useConnect}
        fetchProvider={async () => null}
        onAction={onAction}
      />,
    );

    // The authorization window cannot be observed, so dismissing is the user's
    // only exit and must never be disabled while waiting.
    const dismissButton = getByRole("button", { name: "Dismiss" });
    expect((dismissButton as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(dismissButton);
    expect(stub.dismiss).toHaveBeenCalled();
    expect(onAction).toHaveBeenCalledWith("surface-1", "cancel", {
      status: "cancelled",
      providerKey: "google",
      providerLabel: "Google",
    });
  });

  test("an open authorization emits no action on its own", () => {
    const onAction = mock(() => {});
    const stub = stubConnect({ status: "attempting" });
    renderWithQueryClient(
      <OAuthConnectSurface
        surface={makeSurface(OAUTH_SURFACE)}
        assistantId="assistant-1"
        useConnect={stub.useConnect}
        fetchProvider={async () => null}
        onAction={onAction}
      />,
    );

    // Waiting says nothing about what the user decided.
    expect(onAction).not.toHaveBeenCalled();
  });

  test("a failed authorization shows its message and emits no action", () => {
    const onAction = mock(() => {});
    const stub = stubConnect({ errorMessage: "Google authorization failed" });
    const { getByText } = renderWithQueryClient(
      <OAuthConnectSurface
        surface={makeSurface(OAUTH_SURFACE)}
        assistantId="assistant-1"
        useConnect={stub.useConnect}
        fetchProvider={async () => null}
        onAction={onAction}
      />,
    );

    expect(getByText("Google authorization failed")).toBeTruthy();
    expect(onAction).not.toHaveBeenCalled();
  });

  test("missing configuration disables connecting", () => {
    const stub = stubConnect();
    const { getByRole } = renderWithQueryClient(
      <OAuthConnectSurface
        surface={makeSurface({
          surfaceType: "oauth_connect",
          data: { providerKey: "" },
        })}
        assistantId="assistant-1"
        useConnect={stub.useConnect}
        fetchProvider={async () => null}
        onAction={mock(() => {})}
      />,
    );

    expect(
      (getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("SurfaceRouter", () => {
  test("threads the owning assistant id into the surface's markdown", () => {
    const { getByTestId } = render(
      <SurfaceRouter
        surface={makeSurface({
          data: {
            description: "See [the report](vellum://workspace/report.pdf).",
            options: [{ id: "inbox", title: "Clean up my inbox" }],
          },
        })}
        onAction={() => {}}
        assistantId="asst-owner"
      />,
    );

    expect(getByTestId("markdown").getAttribute("data-assistant-id")).toBe(
      "asst-owner",
    );
  });

  test("collapses completed choice surfaces into a completion chip", () => {
    const { queryByText, getByText } = render(
      <SurfaceRouter
        surface={makeSurface({
          completed: true,
          completionSummary: 'User chose: "Clean up my inbox"',
          data: {
            options: [{ id: "inbox", title: "Clean up my inbox" }],
          },
        })}
        onAction={() => {}}
      />,
    );

    expect(queryByText("Clean up my inbox")).toBeNull();
    expect(getByText('User chose: "Clean up my inbox"')).toBeTruthy();
  });

  test("collapses completed OAuth connect surfaces into a completion chip", () => {
    const { queryByText, getByText } = render(
      <SurfaceRouter
        surface={makeSurface({
          surfaceType: "oauth_connect",
          completed: true,
          completionSummary: "Connected Google: user@example.com",
          data: {
            providerKey: "google",
            displayName: "Google",
          },
        })}
        onAction={() => {}}
      />,
    );

    expect(queryByText("Connect Google")).toBeNull();
    expect(getByText("Connected Google: user@example.com")).toBeTruthy();
  });
});
