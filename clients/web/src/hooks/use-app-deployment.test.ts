/**
 * Tests for `useAppDeployment` / `copyDeployedAppLink`.
 *
 * Covers:
 *   1. Reporting an app's active deployment (and the absent case), so the
 *      deploy surfaces can say "already deployed" instead of offering a
 *      first-time deploy.
 *   2. Refreshing that answer when a deploy settles, the regression this
 *      hook exists for: right after publishing, the menu must stop saying
 *      "Deploy to Vercel".
 *   3. `enabled: false` issuing no request, which is what keeps the library
 *      grid from firing one status read per card on mount.
 *   4. The copy helper putting the URL on the clipboard *and* showing it.
 *
 * The generated query factory is mocked with a controllable response
 * (mirroring `use-stt-language-selection.test.ts`); the QueryClientProvider
 * and the deploy store are real.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";

const ASSISTANT_ID = "asst-test";
const APP_ID = "app-1";
const PUBLISH_STATUS_KEY = ["publish-status", APP_ID];

interface PublishStatus {
  published: boolean;
  publicUrl?: string;
}

let status: PublishStatus = { published: false };
let fetchCount = 0;

mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  appsByIdPublishstatusGetOptions: () => ({
    queryKey: PUBLISH_STATUS_KEY,
    queryFn: () => {
      fetchCount += 1;
      return Promise.resolve(status);
    },
  }),
  appsByIdPublishstatusGetQueryKey: () => PUBLISH_STATUS_KEY,
}));

const copiedText: string[] = [];
mock.module("@/lib/copy-to-clipboard", () => ({
  copyToClipboard: (
    text: string,
    options: { onCopied?: () => void; errorMessage: string },
  ) => {
    copiedText.push(text);
    options.onCopied?.();
  },
}));

const successToasts: { title: string; description?: string }[] = [];
// The stub stands in for the whole toast module, so it carries every export
// the design-library index re-exports from it. A partial stub breaks any
// module that pulls `Toaster` / `ToastContent` through that index.
mock.module("@vellumai/design-library/components/toast", () => ({
  toast: {
    success: (title: string, options?: { description?: string }) => {
      successToasts.push({ title, description: options?.description });
    },
    error: () => {},
  },
  Toaster: () => null,
  ToastContent: () => null,
}));

const { copyDeployedAppLink, useAppDeployment } = await import(
  "@/hooks/use-app-deployment"
);
const { useDeployStore } = await import("@/stores/deploy-store");

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

beforeEach(() => {
  status = { published: false };
  fetchCount = 0;
  copiedText.length = 0;
  successToasts.length = 0;
  useDeployStore.setState({ isDeploying: false });
});

describe("useAppDeployment", () => {
  test("reports the live URL of an active deployment", async () => {
    status = { published: true, publicUrl: "https://my-app.vercel.app" };
    const { result } = renderHook(
      () => useAppDeployment(ASSISTANT_ID, APP_ID),
      { wrapper },
    );

    await waitFor(() =>
      expect(result.current.deployedUrl).toBe("https://my-app.vercel.app"),
    );
  });

  test("reports no deployment when the app was never published", async () => {
    const { result } = renderHook(
      () => useAppDeployment(ASSISTANT_ID, APP_ID),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.deployedUrl).toBeNull();
  });

  test("picks up the deployment as soon as a deploy settles", async () => {
    const { result } = renderHook(
      () => useAppDeployment(ASSISTANT_ID, APP_ID),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.deployedUrl).toBeNull();

    // A deploy runs to completion through the store; the daemon now has a
    // published record for this app.
    status = { published: true, publicUrl: "https://my-app.vercel.app" };
    act(() => {
      useDeployStore.setState({ isDeploying: true });
    });
    act(() => {
      useDeployStore.setState({ isDeploying: false });
    });

    await waitFor(() =>
      expect(result.current.deployedUrl).toBe("https://my-app.vercel.app"),
    );
  });

  test("issues no request while disabled", async () => {
    const { result } = renderHook(
      () => useAppDeployment(ASSISTANT_ID, APP_ID, { enabled: false }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchCount).toBe(0);
    expect(result.current.deployedUrl).toBeNull();
  });

  test("issues no request without an app", async () => {
    renderHook(() => useAppDeployment(ASSISTANT_ID, null), { wrapper });
    await waitFor(() => expect(fetchCount).toBe(0));
  });
});

describe("copyDeployedAppLink", () => {
  test("copies the URL and shows it back to the user", () => {
    copyDeployedAppLink("https://my-app.vercel.app");

    expect(copiedText).toEqual(["https://my-app.vercel.app"]);
    expect(successToasts).toHaveLength(1);
    expect(successToasts[0]?.description).toBe("https://my-app.vercel.app");
  });
});
