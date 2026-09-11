/**
 * The mobile Library route as it is assembled in the app: LibraryView fills
 * the IntelligenceLayout action slot, IntelligenceLayout publishes the
 * complete mobile navigation row, and ChatLayoutHeader renders that row above
 * the full-bleed page surface. Keeping the whole chain in one story protects
 * the layout-slot handoff as well as the individual controls and cards.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import { Route, Routes } from "react-router";

import { useChatLayoutSlotsStore } from "@/components/layout/chat-layout-slots-store";
import { useIntelligenceLayoutSlotsStore } from "@/components/layout/intelligence-layout-slots-store";
import { ChatLayoutHeader } from "@/domains/chat/chat-layout-header";
import { IntelligenceLayout } from "@/domains/intelligence/intelligence-layout";
import { LibraryView } from "@/domains/library/library-view";
import {
  appsGetQueryKey,
  documentsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type {
  AppsGetResponse,
  DocumentsGetResponse,
} from "@/generated/daemon/types.gen";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import type { AppSummary } from "@/types/app-types";
import {
  clearAppHtmlCache,
  primeAppHtmlCache,
} from "@/utils/app-html-cache";

const ASSISTANT_ID = "assistant-library-story";

const STORY_APPS: AppSummary[] = [
  {
    id: "app-threadkeeper",
    name: "Threadkeeper",
    createdAt: new Date("2026-08-17T12:00:00Z").getTime(),
    updatedAt: new Date("2026-08-17T12:00:00Z").getTime(),
    version: "1",
    contentId: "content-threadkeeper",
    origin: "workspace",
  },
  {
    id: "app-calculator",
    name: "Calculator",
    createdAt: new Date("2026-06-22T12:00:00Z").getTime(),
    updatedAt: new Date("2026-06-22T12:00:00Z").getTime(),
    version: "1",
    contentId: "content-calculator",
    origin: "workspace",
  },
];

const THREADKEEPER_PREVIEW = `<!doctype html>
<html>
  <body style="box-sizing:border-box;margin:0;padding:34px;background:#f4f3ea;color:#202624;font-family:ui-monospace,monospace">
    <div style="font-size:11px;letter-spacing:3px;color:#67706b">THREADKEEPER / FIELD NOTES</div>
    <h1 style="margin:12px 0 5px;font:42px Georgia,serif">Keep the thread.</h1>
    <p style="margin:0;color:#6f7772;font:18px Georgia,serif">A quiet map of what you meant to return to.</p>
    <div style="display:flex;gap:28px;margin-top:30px;padding:18px 0;border-top:1px solid #d8d7ce;border-bottom:1px solid #d8d7ce;font-size:12px;color:#6f7772">
      <strong style="color:#202624">Open now</strong><span>Threads</span><span>Needs review</span><span>Connections</span>
    </div>
  </body>
</html>`;

const CALCULATOR_PREVIEW = `<!doctype html>
<html>
  <body style="box-sizing:border-box;margin:0;min-height:100vh;display:grid;place-items:center;background:#05050d;color:#f7f4ed;font-family:system-ui,sans-serif">
    <div style="width:176px;padding:18px;background:#14141d;border-radius:20px;box-shadow:0 18px 50px #0008">
      <div style="height:46px;margin-bottom:12px;text-align:right;font-size:34px">0</div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px">
        <span style="color:#ff6961">AC</span><span>+/−</span><span>%</span><span style="color:#ff8b32">÷</span>
        <span>7</span><span>8</span><span>9</span><span style="color:#ff8b32">×</span>
        <span>4</span><span>5</span><span>6</span><span style="color:#ff8b32">−</span>
        <span>1</span><span>2</span><span>3</span><span style="color:#ff8b32">+</span>
      </div>
    </div>
  </body>
</html>`;

function createStoryClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData<AppsGetResponse>(
    appsGetQueryKey({ path: { assistant_id: ASSISTANT_ID } }),
    { apps: STORY_APPS },
  );
  client.setQueryData<DocumentsGetResponse>(
    documentsGetQueryKey({ path: { assistant_id: ASSISTANT_ID } }),
    { documents: [] },
  );
  client.setQueryData(
    ["assistant-capability", "appPins", ASSISTANT_ID],
    true,
  );
  return client;
}

/**
 * Seeds every external source before the route's first render and marks the
 * preview as an iOS shell so native-mobile utilities match the shipped page.
 */
const withLibraryFixture: Decorator = function WithLibraryFixture(Story) {
  const [client] = useState(createStoryClient);
  const [previousState] = useState(() => {
    const previous = {
      assistantId:
        useResolvedAssistantsStore.getState().activeAssistantId ?? null,
      identity: {
        name: useAssistantIdentityStore.getState().name,
        version: useAssistantIdentityStore.getState().version,
        assistantId: useAssistantIdentityStore.getState().assistantId,
      },
      nativePlatform: document.documentElement.dataset.nativePlatform,
    };

    useResolvedAssistantsStore.setState({ activeAssistantId: ASSISTANT_ID });
    useAssistantIdentityStore
      .getState()
      .setIdentity("Example Assistant", "1.0.0", ASSISTANT_ID);
    useChatLayoutSlotsStore.getState().setTopBarCenter(null);
    useChatLayoutSlotsStore.getState().setMobileTopBar(null);
    useIntelligenceLayoutSlotsStore.getState().setHeaderTrailing(null);
    document.documentElement.dataset.nativePlatform = "ios";
    primeAppHtmlCache(
      ASSISTANT_ID,
      "app-threadkeeper",
      THREADKEEPER_PREVIEW,
    );
    primeAppHtmlCache(ASSISTANT_ID, "app-calculator", CALCULATOR_PREVIEW);

    return previous;
  });

  useEffect(() => {
    return () => {
      useResolvedAssistantsStore.setState({
        activeAssistantId: previousState.assistantId,
      });
      useAssistantIdentityStore.getState().setIdentity(
        previousState.identity.name,
        previousState.identity.version,
        previousState.identity.assistantId,
      );
      useChatLayoutSlotsStore.getState().setTopBarCenter(null);
      useChatLayoutSlotsStore.getState().setMobileTopBar(null);
      useIntelligenceLayoutSlotsStore.getState().setHeaderTrailing(null);
      if (previousState.nativePlatform == null) {
        delete document.documentElement.dataset.nativePlatform;
      } else {
        document.documentElement.dataset.nativePlatform =
          previousState.nativePlatform;
      }
      clearAppHtmlCache(ASSISTANT_ID, "app-threadkeeper");
      clearAppHtmlCache(ASSISTANT_ID, "app-calculator");
    };
  }, [previousState]);

  return (
    <QueryClientProvider client={client}>
      <Story />
    </QueryClientProvider>
  );
};

function MobileLibraryPage() {
  const isMobile = useIsMobile();
  const mobileTopBar = useChatLayoutSlotsStore.use.mobileTopBar();

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-[var(--surface-overlay)]">
      <ChatLayoutHeader
        isMobile={isMobile}
        drawerOpen={false}
        collapsed
        toggleSidebar={() => {}}
        mobileTopBar={mobileTopBar}
      />
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <Routes>
          <Route element={<IntelligenceLayout />}>
            <Route
              path="/assistant/library"
              element={
                <LibraryView
                  assistantId={ASSISTANT_ID}
                  assistantName="Example Assistant"
                  onOpenApp={() => {}}
                />
              }
            />
          </Route>
        </Routes>
      </main>
    </div>
  );
}

const meta: Meta<typeof MobileLibraryPage> = {
  title: "Library/LibraryPage",
  component: MobileLibraryPage,
  tags: ["!autodocs"],
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    router: { initialEntries: ["/assistant/library"] },
  },
  decorators: [withLibraryFixture],
};

export default meta;
type Story = StoryObj<typeof MobileLibraryPage>;

/** Phone-width route with the consolidated top bar and labels below cards. */
export const Mobile: Story = {
  globals: {
    theme: "dark",
    viewport: { value: "sbMobile", isRotated: false },
  },
};
