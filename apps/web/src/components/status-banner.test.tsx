import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

let isNativePlatformMock = false;
let connectedMock = true;
let connectivityStateMock: "online" | "device-offline" | "backend-unreachable" =
  "online";
let isElectronMock = false;
let activeAssistantIdMock: string | null = "assistant-123";
let operationalStatusAssistantIdMock: string | null = null;
let assistantStateMock:
  | { kind: "loading" }
  | { kind: "active"; isLocal: boolean; maintenanceMode?: { enabled: boolean } } =
  { kind: "active", isLocal: false };
let requestedOperationalStatusAssistantId: string | null | undefined;
let operationalStatusQueryMock: {
  data: { state: string } | null | undefined;
  isError: boolean;
  refetch?: () => void;
} = {
  data: null,
  isError: false,
};
let StatusBanner: ComponentType<{ className?: string }>;

mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => isNativePlatformMock,
  useIsNativePlatform: () => isNativePlatformMock,
}));

mock.module("@/hooks/use-network-status", () => ({
  useNetworkStatus: () => connectedMock,
}));

mock.module("@/hooks/use-connectivity-state", () => ({
  useConnectivityState: () => ({
    connectivityState: connectivityStateMock,
    retryConnectivity: () => {},
  }),
}));

mock.module("@/runtime/is-electron", () => ({
  isElectron: () => isElectronMock,
}));

mock.module("react-router", () => ({
  Link: (props: { to: string; children: ReactNode }) => (
    <a href={props.to}>{props.children}</a>
  ),
}));

mock.module("@/generated/api/sdk.gen", () => ({
  assistantsMaintenanceModeExitCreate: () =>
    Promise.resolve({ response: new Response(null, { status: 204 }) }),
}));

mock.module("@/assistant/lifecycle-service", () => ({
  lifecycleService: {
    checkAssistant: () => Promise.resolve(),
  },
}));

mock.module("@/lib/sentry/capture-error", () => ({
  captureError: () => {},
}));

mock.module("@/assistant/operational-status", () => ({
  isHealthyOperationalStatus: (status: { state?: string } | null | undefined) =>
    status?.state === "active",
  useAssistantOperationalStatus: (assistantId: string | null) => {
    requestedOperationalStatusAssistantId = assistantId;
    return {
      ...operationalStatusQueryMock,
      refetch: operationalStatusQueryMock.refetch ?? (() => {}),
    };
  },
}));

mock.module("@/assistant/lifecycle-store", () => ({
  useAssistantLifecycleStore: {
    use: {
      assistantState: () => assistantStateMock,
      operationalStatusAssistantId: () => operationalStatusAssistantIdMock,
    },
  },
}));

mock.module("@/stores/resolved-assistants-store", () => ({
  useResolvedAssistantsStore: {
    use: {
      activeAssistantId: () => activeAssistantIdMock,
    },
  },
}));

mock.module("@vellumai/design-library/components/notice", () => ({
  Notice: (props: {
    title: ReactNode;
    tone?: string;
    icon?: ReactNode;
    actions?: ReactNode;
  }) => (
    <div data-testid="notice" data-tone={props.tone}>
      {props.icon}
      {props.title}
      {props.actions}
    </div>
  ),
}));

mock.module("@vellumai/design-library/components/button", () => ({
  Button: (props: { children: ReactNode }) => (
    <button data-testid="button">{props.children}</button>
  ),
}));

beforeAll(async () => {
  ({ StatusBanner } = await import("@/components/status-banner"));
});

beforeEach(() => {
  isNativePlatformMock = false;
  connectedMock = true;
  connectivityStateMock = "online";
  isElectronMock = false;
  activeAssistantIdMock = "assistant-123";
  operationalStatusAssistantIdMock = null;
  assistantStateMock = { kind: "active", isLocal: false };
  requestedOperationalStatusAssistantId = undefined;
  operationalStatusQueryMock = {
    data: null,
    isError: false,
  };
});

describe("StatusBanner", () => {
  test("renders nothing on web without an operational status", () => {
    const html = renderToStaticMarkup(<StatusBanner />);
    expect(html).toBe("");
  });

  test("renders nothing for healthy operational status", () => {
    operationalStatusQueryMock = {
      data: { state: "active" },
      isError: false,
    };

    const html = renderToStaticMarkup(<StatusBanner />);

    expect(html).toBe("");
  });

  test("renders operational status banners on web", () => {
    operationalStatusQueryMock = {
      data: { state: "restarting" },
      isError: false,
    };

    const html = renderToStaticMarkup(<StatusBanner />);

    expect(html).toContain("Assistant is restarting");
    expect(html).toContain('data-tone="warning"');
  });

  test("uses lifecycle operation assistant id when present", () => {
    activeAssistantIdMock = "assistant-active";
    operationalStatusAssistantIdMock = "assistant-operation";

    renderToStaticMarkup(<StatusBanner />);

    expect(requestedOperationalStatusAssistantId).toBe("assistant-operation");
  });

  test("renders operational error states with error tone and Doctor action for platform assistants", () => {
    for (const [state, title] of [
      ["crash_loop", "Assistant is crash looping"],
      ["unreachable", "Assistant is unreachable"],
      ["not_found", "Assistant was not found"],
    ] as const) {
      operationalStatusQueryMock = {
        data: { state },
        isError: false,
      };

      const html = renderToStaticMarkup(<StatusBanner />);

      expect(html).toContain(title);
      expect(html).toContain('data-tone="error"');
      expect(html).toContain("Go to Doctor");
      expect(html).toContain("/assistant/settings/debug?tab=doctor");
    }
  });

  test("does not render Doctor action for local assistant operational errors", () => {
    assistantStateMock = { kind: "active", isLocal: true };
    operationalStatusQueryMock = {
      data: { state: "crash_loop" },
      isError: false,
    };

    const html = renderToStaticMarkup(<StatusBanner />);

    expect(html).toContain("Assistant is crash looping");
    expect(html).not.toContain("Go to Doctor");
  });

  test("does not render Doctor action for lifecycle operation errors that do not target the active assistant", () => {
    activeAssistantIdMock = "assistant-active";
    operationalStatusAssistantIdMock = "assistant-operation";
    operationalStatusQueryMock = {
      data: { state: "crash_loop" },
      isError: false,
    };

    const html = renderToStaticMarkup(<StatusBanner />);

    expect(requestedOperationalStatusAssistantId).toBe("assistant-operation");
    expect(html).toContain("Assistant is crash looping");
    expect(html).not.toContain("Go to Doctor");
  });

  test("renders quiet operational states with lower-severity tones", () => {
    operationalStatusQueryMock = {
      data: { state: "sleeping" },
      isError: false,
    };

    const sleepingHtml = renderToStaticMarkup(<StatusBanner />);

    expect(sleepingHtml).toContain("Assistant is sleeping");
    expect(sleepingHtml).toContain('data-tone="neutral"');

    operationalStatusQueryMock = {
      data: { state: "maintenance_mode" },
      isError: false,
    };

    const maintenanceHtml = renderToStaticMarkup(<StatusBanner />);

    expect(maintenanceHtml).toContain("Assistant is in maintenance mode");
    expect(maintenanceHtml).toContain('data-tone="info"');
    expect(maintenanceHtml).toContain("Resume Assistant");
  });

  test("renders maintenance mode from lifecycle state when operational status is absent", () => {
    assistantStateMock = {
      kind: "active",
      isLocal: false,
      maintenanceMode: { enabled: true },
    };

    const html = renderToStaticMarkup(<StatusBanner />);

    expect(html).toContain("Assistant is in maintenance mode");
    expect(html).toContain('data-tone="info"');
    expect(html).toContain("Resume Assistant");
  });

  test("renders status query failures as error banners", () => {
    operationalStatusQueryMock = {
      data: null,
      isError: true,
    };

    const html = renderToStaticMarkup(<StatusBanner />);

    expect(html).toContain("Assistant status is unavailable");
    expect(html).toContain('data-tone="error"');
    expect(html).toContain("Go to Doctor");
  });

  test("does not render Doctor action for local assistant status query failures", () => {
    assistantStateMock = { kind: "active", isLocal: true };
    operationalStatusQueryMock = {
      data: null,
      isError: true,
    };

    const html = renderToStaticMarkup(<StatusBanner />);

    expect(html).toContain("Assistant status is unavailable");
    expect(html).not.toContain("Go to Doctor");
  });

  describe("Capacitor iOS", () => {
    test("renders nothing when connected and operational status is healthy", () => {
      isNativePlatformMock = true;
      connectedMock = true;
      const html = renderToStaticMarkup(<StatusBanner />);
      expect(html).toBe("");
    });

    test("renders device-offline banner before operational status", () => {
      isNativePlatformMock = true;
      connectedMock = false;
      operationalStatusQueryMock = {
        data: { state: "crash_loop" },
        isError: false,
      };

      const html = renderToStaticMarkup(<StatusBanner />);

      expect(html).toContain("offline");
      expect(html).not.toContain("crash looping");
    });
  });

  describe("Electron", () => {
    test("renders nothing when online and operational status is healthy", () => {
      isElectronMock = true;
      connectivityStateMock = "online";
      const html = renderToStaticMarkup(<StatusBanner />);
      expect(html).toBe("");
    });

    test("renders device-offline banner before operational status", () => {
      isElectronMock = true;
      connectivityStateMock = "device-offline";
      operationalStatusQueryMock = {
        data: { state: "crash_loop" },
        isError: false,
      };

      const html = renderToStaticMarkup(<StatusBanner />);

      expect(html).toContain("offline");
      expect(html).not.toContain("crash looping");
    });

    test("renders backend-unreachable banner before operational status", () => {
      isElectronMock = true;
      connectivityStateMock = "backend-unreachable";
      operationalStatusQueryMock = {
        data: { state: "crash_loop" },
        isError: false,
      };

      const html = renderToStaticMarkup(<StatusBanner />);

      expect(html).toContain("Trying to reach Vellum");
      expect(html).toContain("Retry now");
      expect(html).not.toContain("crash looping");
    });

    test("does not render backend-unreachable connectivity state outside Electron", () => {
      connectivityStateMock = "backend-unreachable";

      const html = renderToStaticMarkup(<StatusBanner />);

      expect(html).toBe("");
    });
  });
});
