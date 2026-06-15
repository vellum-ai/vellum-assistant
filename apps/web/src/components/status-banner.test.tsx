import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

let isNativePlatformMock = false;
let connectedMock = true;
let connectivityStateMock: "online" | "device-offline" | "backend-unreachable" =
  "online";
let retryConnectivityMock = mock(async () => connectivityStateMock);
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
let localHealthMock:
  | "healthy"
  | "unhealthy"
  | "unreachable"
  | "sleeping"
  | "starting"
  | "crashed"
  | null = null;
let checkAssistantMock = mock(async () => {});
let triggerReachabilityProbeMock = mock(() => {});
let refetchOperationalStatusMock = mock(async () => {});
let wakeLocalAssistantHostMock = mock(async (_assistantId: string) => ({
  ok: true,
}));
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
    retryConnectivity: retryConnectivityMock,
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
    checkAssistant: () => checkAssistantMock(),
    triggerReachabilityProbe: () => triggerReachabilityProbeMock(),
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
      refetch: operationalStatusQueryMock.refetch ?? refetchOperationalStatusMock,
    };
  },
}));

mock.module("@/assistant/local-health", () => ({
  useLocalAssistantHealth: () => localHealthMock,
}));

mock.module("@/runtime/local-mode-host", () => ({
  wakeLocalAssistantHost: (assistantId: string) =>
    wakeLocalAssistantHostMock(assistantId),
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
    children?: ReactNode;
    actions?: ReactNode;
    className?: string;
  }) => (
    <div
      data-testid="notice"
      data-tone={props.tone}
      data-class-name={props.className}
    >
      {props.icon}
      {props.title}
      {props.children}
      {props.actions}
    </div>
  ),
}));

mock.module("@vellumai/design-library/components/button", () => ({
  Button: (props: {
    children: ReactNode;
    disabled?: boolean;
    leftIcon?: ReactNode;
    onClick?: () => void;
  }) => (
    <button
      data-testid="button"
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.leftIcon}
      {props.children}
    </button>
  ),
}));

beforeAll(async () => {
  ({ StatusBanner } = await import("@/components/status-banner"));
});

beforeEach(() => {
  isNativePlatformMock = false;
  connectedMock = true;
  connectivityStateMock = "online";
  retryConnectivityMock = mock(async () => connectivityStateMock);
  isElectronMock = false;
  activeAssistantIdMock = "assistant-123";
  operationalStatusAssistantIdMock = null;
  assistantStateMock = { kind: "active", isLocal: false };
  requestedOperationalStatusAssistantId = undefined;
  operationalStatusQueryMock = {
    data: null,
    isError: false,
  };
  localHealthMock = null;
  checkAssistantMock = mock(async () => {});
  triggerReachabilityProbeMock = mock(() => {});
  refetchOperationalStatusMock = mock(async () => {});
  wakeLocalAssistantHostMock = mock(async (_assistantId: string) => ({
    ok: true,
  }));
});

afterEach(() => {
  cleanup();
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

  describe("local assistant health", () => {
    test("renders nothing when the local assistant is healthy", () => {
      localHealthMock = "healthy";

      const html = renderToStaticMarkup(<StatusBanner />);

      expect(html).toBe("");
    });

    test("renders an asleep banner with a wake action when the local assistant is sleeping", () => {
      localHealthMock = "sleeping";

      const html = renderToStaticMarkup(<StatusBanner />);

      expect(html).toContain("Your assistant is asleep");
      expect(html).toContain("Wake up");
      expect(html).toContain('data-tone="neutral"');
      expect(html).toContain("items-center");
    });

    test("renders unreachable local health as an asleep fallback", () => {
      localHealthMock = "unreachable";

      const html = renderToStaticMarkup(<StatusBanner />);

      expect(html).toContain("Your assistant is asleep");
      expect(html).toContain("Wake up");
      expect(html).toContain('data-tone="neutral"');
      expect(html).not.toContain("Your assistant is unreachable");
    });

    test("wakes the active local assistant from the banner action", async () => {
      localHealthMock = "sleeping";

      render(<StatusBanner />);
      fireEvent.click(screen.getByRole("button", { name: "Wake up" }));

      await waitFor(() => {
        expect(wakeLocalAssistantHostMock).toHaveBeenCalledWith("assistant-123");
      });
      expect(refetchOperationalStatusMock).toHaveBeenCalledTimes(1);
      expect(retryConnectivityMock).toHaveBeenCalledTimes(1);
      expect(checkAssistantMock).toHaveBeenCalledTimes(1);
      expect(triggerReachabilityProbeMock).toHaveBeenCalledTimes(1);
    });

    test("keeps showing waking after wake succeeds if the next health value is briefly crashed", async () => {
      localHealthMock = "sleeping";
      const wakeResolver: {
        current?: (value: { ok: true }) => void;
      } = {};
      wakeLocalAssistantHostMock = mock(
        () =>
          new Promise<{ ok: true }>((resolve) => {
            wakeResolver.current = resolve;
          }),
      );

      const { rerender } = render(<StatusBanner />);
      fireEvent.click(screen.getByRole("button", { name: "Wake up" }));

      await waitFor(() => {
        expect(wakeLocalAssistantHostMock).toHaveBeenCalledWith(
          "assistant-123",
        );
      });

      localHealthMock = "crashed";
      rerender(<StatusBanner />);
      expect(screen.getByText("Your assistant is waking up")).toBeTruthy();
      expect(screen.queryByText("Your assistant crashed")).toBeNull();

      const resolveWake = wakeResolver.current;
      if (!resolveWake) throw new Error("wake promise was not started");
      resolveWake({ ok: true });
      await waitFor(() => {
        expect(triggerReachabilityProbeMock).toHaveBeenCalledTimes(1);
      });

      rerender(<StatusBanner />);
      expect(screen.getByText("Your assistant is waking up")).toBeTruthy();
      expect(screen.queryByText("Your assistant crashed")).toBeNull();
    });

    test("renders a distinct crashed banner for local assistant crashes", () => {
      localHealthMock = "crashed";

      const html = renderToStaticMarkup(<StatusBanner />);

      expect(html).toContain("Your assistant crashed");
      expect(html).toContain("Wake up");
      expect(html).toContain('data-tone="error"');
    });

    test("renders a waking banner while the local assistant is starting", () => {
      localHealthMock = "starting";

      const html = renderToStaticMarkup(<StatusBanner />);

      expect(html).toContain("Your assistant is waking up");
      expect(html).not.toContain("Wake up");
      expect(html).toContain('data-tone="neutral"');
    });

    test("renders a warning banner when the local assistant is unhealthy", () => {
      localHealthMock = "unhealthy";

      const html = renderToStaticMarkup(<StatusBanner />);

      expect(html).toContain("Assistant is unhealthy");
      expect(html).toContain('data-tone="warning"');
    });

    test("renders device-offline banner before local health", () => {
      isElectronMock = true;
      connectivityStateMock = "device-offline";
      localHealthMock = "sleeping";

      const html = renderToStaticMarkup(<StatusBanner />);

      expect(html).toContain("offline");
      expect(html).not.toContain("asleep");
    });

    test("renders local health before Electron backend-unreachable connectivity", () => {
      isElectronMock = true;
      connectivityStateMock = "backend-unreachable";
      localHealthMock = "sleeping";

      const html = renderToStaticMarkup(<StatusBanner />);

      expect(html).toContain("Your assistant is asleep");
      expect(html).toContain("Wake up");
      expect(html).not.toContain("Trying to reach Vellum");
      expect(html).not.toContain("Retry now");
    });

    test("renders local waking before Electron backend-unreachable connectivity", () => {
      isElectronMock = true;
      connectivityStateMock = "backend-unreachable";
      localHealthMock = "starting";

      const html = renderToStaticMarkup(<StatusBanner />);

      expect(html).toContain("Your assistant is waking up");
      expect(html).not.toContain("Trying to reach Vellum");
    });
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
