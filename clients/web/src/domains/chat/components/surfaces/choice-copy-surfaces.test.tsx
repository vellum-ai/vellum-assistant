import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  type QueryKey,
} from "@tanstack/react-query";
import type { ReactElement } from "react";

mock.module("@/domains/chat/components/chat-markdown-message", () => ({
  ChatMarkdownMessage: ({ content }: { content: string }) => (
    <div>{content}</div>
  ),
}));

// The connections-cache invalidation resolves the platform-scoped assistant id
// first; short-circuit it to the input so the invalidated key is deterministic
// and no local-mode / gateway graph is exercised.
mock.module("@/lib/local-platform-identity", () => ({
  resolveLocalAssistantPlatformIdentity: async (id: string) => id,
}));

import { ChoiceSurface } from "@/domains/chat/components/surfaces/choice-surface";
import { CopyBlockSurface } from "@/domains/chat/components/surfaces/copy-block-surface";
import { OAuthConnectSurface } from "@/domains/chat/components/surfaces/oauth-connect-surface";
import { SurfaceRouter } from "@/domains/chat/components/surfaces/surface-router";
import type { ManagedOAuthConnectClient } from "@/domains/chat/api/managed-oauth";
import type { OAuthConnection } from "@/generated/api/types.gen";
import type { Surface } from "@/domains/chat/types/types";
import { assistantsOauthConnectionsListQueryKey } from "@/generated/api/@tanstack/react-query.gen";

afterAll(() => {
  mock.restore();
});

afterEach(() => {
  cleanup();
});

function makeSurface(overrides: Partial<Surface>): Surface {
  return {
    surfaceId: "surface-1",
    surfaceType: "choice",
    data: {},
    ...overrides,
  };
}

/**
 * Render inside a real QueryClient (OAuthConnectSurface calls `useQueryClient`),
 * with `invalidateQueries` spied so the connections-cache refresh is assertable.
 */
function renderWithClient(ui: ReactElement) {
  const queryClient = new QueryClient();
  const invalidateQueries = mock((_arg?: { queryKey?: QueryKey }) =>
    Promise.resolve(),
  );
  queryClient.invalidateQueries = invalidateQueries as never;
  const result = render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
  return { ...result, queryClient, invalidateQueries };
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

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        "Paste this into another assistant.",
      );
    });
    expect(getByRole("button", { name: "Copied" })).toBeTruthy();
  });
});

describe("OAuthConnectSurface", () => {
  test("starts managed OAuth and submits the connected account", async () => {
    const onAction = mock(() => {});
    const oauthClient: ManagedOAuthConnectClient = {
      fetchProvider: mock(async () => null),
      connect: mock(async () => ({
        status: "connected" as const,
        connection: {
          id: "conn-1",
          provider: "google",
          status: "ACTIVE",
          connected: true,
          account_label: "user@example.com",
          scopes_granted: ["gmail.readonly"],
          expires_at: null,
        } as OAuthConnection,
      })),
    };

    const { getByRole, queryByText } = renderWithClient(
      <OAuthConnectSurface
        surface={makeSurface({
          surfaceType: "oauth_connect",
          title: "Connect Google",
          data: {
            providerKey: "google",
            displayName: "Google",
            description: "Connect Gmail for this task.",
            connectLabel: "Connect Google Account",
            requestedScopes: ["gmail.readonly"],
          },
        })}
        assistantId="assistant-1"
        assistantDisplayName="Assistant"
        oauthClient={oauthClient}
        onAction={onAction}
      />,
    );

    expect(queryByText("gmail.readonly")).toBeNull();
    expect(queryByText("Connect Google Account")).toBeNull();
    expect(
      getByRole("button", { name: "About assistant approval" }),
    ).toBeTruthy();

    fireEvent.click(getByRole("button", { name: "Connect" }));

    await waitFor(() => {
      expect(oauthClient.connect).toHaveBeenCalledWith({
        assistantId: "assistant-1",
        providerKey: "google",
        providerLabel: "Google",
      });
      expect(onAction).toHaveBeenCalledWith("surface-1", "connect", {
        status: "connected",
        providerKey: "google",
        providerLabel: "Google",
        connectionId: "conn-1",
        accountLabel: "user@example.com",
        scopesGranted: ["gmail.readonly"],
      });
    });
  });

  test("does not double the verb when displayName already includes 'Connect'", () => {
    const oauthClient: ManagedOAuthConnectClient = {
      fetchProvider: mock(async () => null),
      connect: mock(async () => ({ status: "cancelled" as const })),
    };

    const { getByText, queryByText } = renderWithClient(
      <OAuthConnectSurface
        surface={makeSurface({
          surfaceType: "oauth_connect",
          data: {
            providerKey: "google",
            displayName: "Connect Gmail",
          },
        })}
        assistantId="assistant-1"
        oauthClient={oauthClient}
        onAction={mock(() => {})}
      />,
    );

    expect(getByText("Connect Gmail")).toBeTruthy();
    expect(queryByText("Connect Connect Gmail")).toBeNull();
    // The description fallback resolves through the same normalized label,
    // so it must not double the verb either.
    expect(
      getByText("Connect Gmail so I can use it for this task.", {
        exact: false,
      }),
    ).toBeTruthy();
  });

  test("lets the user cancel without opening OAuth", () => {
    const onAction = mock(() => {});
    const oauthClient: ManagedOAuthConnectClient = {
      fetchProvider: mock(async () => null),
      connect: mock(async () => ({ status: "cancelled" as const })),
    };

    const { getByRole } = renderWithClient(
      <OAuthConnectSurface
        surface={makeSurface({
          surfaceType: "oauth_connect",
          data: {
            providerKey: "linear",
            displayName: "Linear",
          },
        })}
        assistantId="assistant-1"
        oauthClient={oauthClient}
        onAction={onAction}
      />,
    );

    fireEvent.click(getByRole("button", { name: "Dismiss" }));

    expect(oauthClient.connect).not.toHaveBeenCalled();
    expect(onAction).toHaveBeenCalledWith("surface-1", "cancel", {
      status: "cancelled",
      providerKey: "linear",
      providerLabel: "Linear",
    });
  });

  test("refreshes the connections cache after a successful connect (still fires onAction)", async () => {
    const onAction = mock(() => {});
    const oauthClient: ManagedOAuthConnectClient = {
      fetchProvider: mock(async () => null),
      connect: mock(async () => ({
        status: "connected" as const,
        connection: {
          id: "conn-1",
          provider: "google",
          status: "ACTIVE",
          connected: true,
          account_label: "user@example.com",
          scopes_granted: [],
          expires_at: null,
        } as OAuthConnection,
      })),
    };

    const { getByRole, invalidateQueries } = renderWithClient(
      <OAuthConnectSurface
        surface={makeSurface({
          surfaceType: "oauth_connect",
          data: { providerKey: "google", displayName: "Google" },
        })}
        assistantId="assistant-1"
        oauthClient={oauthClient}
        onAction={onAction}
      />,
    );

    fireEvent.click(getByRole("button", { name: "Connect" }));

    // The connections list query is keyed by the platform-scoped assistant id
    // (mocked to the input here); a successful connect must invalidate it so a
    // just-connected account repaints as connected wherever the list is mounted.
    const expectedKey = assistantsOauthConnectionsListQueryKey({
      path: { assistant_id: "assistant-1" },
    });
    await waitFor(() => {
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: expectedKey });
      expect(onAction).toHaveBeenCalledWith(
        "surface-1",
        "connect",
        expect.objectContaining({ status: "connected", providerKey: "google" }),
      );
    });
  });

  test("does not refresh the connections cache when the user cancels", async () => {
    const oauthClient: ManagedOAuthConnectClient = {
      fetchProvider: mock(async () => null),
      connect: mock(async () => ({ status: "cancelled" as const })),
    };

    const { getByRole, invalidateQueries } = renderWithClient(
      <OAuthConnectSurface
        surface={makeSurface({
          surfaceType: "oauth_connect",
          data: { providerKey: "google", displayName: "Google" },
        })}
        assistantId="assistant-1"
        oauthClient={oauthClient}
        onAction={mock(() => {})}
      />,
    );

    fireEvent.click(getByRole("button", { name: "Connect" }));

    await waitFor(() => {
      expect(oauthClient.connect).toHaveBeenCalledTimes(1);
    });
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  test("does not refresh the connections cache on a connect error", async () => {
    const oauthClient: ManagedOAuthConnectClient = {
      fetchProvider: mock(async () => null),
      connect: mock(async () => ({
        status: "error" as const,
        message: "Authorization failed.",
      })),
    };

    const { getByRole, findByText, invalidateQueries } = renderWithClient(
      <OAuthConnectSurface
        surface={makeSurface({
          surfaceType: "oauth_connect",
          data: { providerKey: "google", displayName: "Google" },
        })}
        assistantId="assistant-1"
        oauthClient={oauthClient}
        onAction={mock(() => {})}
      />,
    );

    fireEvent.click(getByRole("button", { name: "Connect" }));

    // The error message surfaces once the flow settles.
    expect(await findByText("Authorization failed.")).toBeTruthy();
    expect(invalidateQueries).not.toHaveBeenCalled();
  });
});

describe("SurfaceRouter", () => {
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
