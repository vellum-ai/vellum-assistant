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
let selectedAssistantIdMock: string | null = null;
let assistantsMock: Array<{
  id: string;
  isLocal: boolean;
  isPlatformHosted: boolean;
  organizationId?: string | null;
}> = [];
let currentOrganizationIdMock: string | null = "org-1";
let operationalStatusAssistantIdMock: string | null = null;
let assistantStateMock:
  | { kind: "loading" }
  | {
      kind: "active";
      isLocal: boolean;
      maintenanceMode?: { enabled: boolean };
    } = { kind: "active", isLocal: false };
let requestedOperationalStatusAssistantId: string | null | undefined;
let operationalStatusQueryMock: {
  data:
    | {
        state: string;
        detail_state?: string;
        detail?: { reason?: string | null; message?: string | null };
      }
    | null
    | undefined;
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
  | "migrating"
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
let isLocalModeHostAvailableMock = true;
let isCliWakeableMock = true;
let StatusBanner: ComponentType<{
  className?: string;
  placement?: "web" | "electron";
}>;

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
      refetch:
        operationalStatusQueryMock.refetch ?? refetchOperationalStatusMock,
    };
  },
}));

mock.module("@/assistant/local-health", () => ({
  useLocalAssistantHealth: () => localHealthMock,
}));

mock.module("@/runtime/local-mode-host", () => ({
  wakeLocalAssistantHost: (assistantId: string) =>
    wakeLocalAssistantHostMock(assistantId),
  isLocalModeHostAvailable: () => isLocalModeHostAvailableMock,
}));

mock.module("@/lib/local-mode", () => ({
  isCliWakeableAssistant: () => isCliWakeableMock,
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
  assistantsValidForOrg: (
    assistants: typeof assistantsMock,
    activeOrgId: string | null,
  ) =>
    assistants.filter(
      (assistant) =>
        assistant.isLocal ||
        assistant.organizationId == null ||
        assistant.organizationId === activeOrgId,
    ),
  useResolvedAssistantsStore: {
    use: {
      activeAssistantId: () => activeAssistantIdMock,
      selectedAssistantId: () => selectedAssistantIdMock,
      assistants: () => assistantsMock,
    },
  },
}));

mock.module("@/stores/organization-store", () => ({
  useOrganizationStore: {
    use: {
      currentOrganizationId: () => currentOrganizationIdMock,
    },
  },
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
  selectedAssistantIdMock = null;
  assistantsMock = [
    {
      id: "assistant-123",
      isLocal: false,
      isPlatformHosted: true,
      organizationId: "org-1",
    },
  ];
  currentOrganizationIdMock = "org-1";
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
  isLocalModeHostAvailableMock = true;
  isCliWakeableMock = true;
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
    expect(html).toContain("bg-[var(--system-mid-weak)]");
    expect(html).toContain("text-[color:var(--system-mid-strong)]");
  });

  test("uses the full-width web banner sizing by default", () => {
    operationalStatusQueryMock = {
      data: { state: "restarting" },
      isError: false,
    };

    const html = renderToStaticMarkup(<StatusBanner />);

    expect(html).toContain('data-placement="web"');
    expect(html).toContain("min-h-10");
    expect(html).toContain("py-[10px]");
    expect(html).toContain("rounded-none");
  });

  test("uses compact rounded sizing for Electron placement", () => {
    operationalStatusQueryMock = {
      data: { state: "restarting" },
      isError: false,
    };

    const html = renderToStaticMarkup(<StatusBanner placement="electron" />);

    expect(html).toContain('data-placement="electron"');
    expect(html).toContain("min-h-8");
    expect(html).toContain("py-[7px]");
    expect(html).toContain("rounded-[6px]");
  });

  test("uses lifecycle operation assistant id when present", () => {
    activeAssistantIdMock = "assistant-active";
    operationalStatusAssistantIdMock = "assistant-operation";

    renderToStaticMarkup(<StatusBanner />);

    expect(requestedOperationalStatusAssistantId).toBe("assistant-operation");
  });

  test("uses selected platform assistant id while lifecycle is loading", () => {
    activeAssistantIdMock = null;
    assistantStateMock = { kind: "loading" };
    selectedAssistantIdMock = "assistant-selected";
    assistantsMock = [
      {
        id: "assistant-selected",
        isLocal: false,
        isPlatformHosted: true,
        organizationId: "org-1",
      },
    ];
    operationalStatusQueryMock = {
      data: { state: "migrating" },
      isError: false,
    };

    const html = renderToStaticMarkup(<StatusBanner />);

    expect(requestedOperationalStatusAssistantId).toBe("assistant-selected");
    expect(html).toContain("Assistant is migrating");
    expect(html).toContain('data-tone="info"');
  });

  test("falls back to the org's platform assistant when nothing is selected", () => {
    activeAssistantIdMock = null;
    assistantStateMock = { kind: "loading" };
    selectedAssistantIdMock = null;
    assistantsMock = [
      {
        id: "assistant-only",
        isLocal: false,
        isPlatformHosted: true,
        organizationId: "org-1",
      },
    ];

    renderToStaticMarkup(<StatusBanner />);

    expect(requestedOperationalStatusAssistantId).toBe("assistant-only");
  });

  test("falls back to the org's platform assistant even when a local assistant is selected", () => {
    // The fallback is deliberately unconditional — gating it on selection
    // semantics hides the migrating/crash-loop banner for the org's real
    // platform assistant in hydration, cross-org, and store-population
    // edge cases.
    activeAssistantIdMock = null;
    assistantStateMock = { kind: "loading" };
    selectedAssistantIdMock = "assistant-local";
    assistantsMock = [
      {
        id: "assistant-local",
        isLocal: true,
        isPlatformHosted: false,
        organizationId: "org-1",
      },
      {
        id: "assistant-platform",
        isLocal: false,
        isPlatformHosted: true,
        organizationId: "org-1",
      },
    ];

    renderToStaticMarkup(<StatusBanner />);

    expect(requestedOperationalStatusAssistantId).toBe("assistant-platform");
  });

  test("renders operational error states with error tone and Doctor action for platform assistants", () => {
    for (const [state, title] of [
      ["crash_loop", "Assistant is crashed"],
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
      expect(html).toContain("bg-[var(--system-negative-weak)]");
      expect(html).toContain("lucide-triangle-alert");
      expect(html).toContain("Go to Doctor");
      expect(html).toContain("/assistant/settings/debug?tab=doctor");
    }
  });

  test("uses blue for platform activity states from the status guide", () => {
    for (const state of [
      "upgrading_assistant_version",
      "resizing_machine",
      "resizing_storage",
      "initializing",
      "migrating",
      "provisioning",
    ] as const) {
      operationalStatusQueryMock = {
        data: { state },
        isError: false,
      };

      const html = renderToStaticMarkup(<StatusBanner />);

      expect(html).toContain('data-tone="info"');
      expect(html).toContain("bg-[var(--system-info-weak)]");
      expect(html).toContain("text-[color:var(--system-info-strong)]");
      expect(html).toContain("animate-spin");
    }
  });

  test("renders a failed operation as an error with Doctor and Dismiss actions", () => {
    // GIVEN the assistant upgrade has failed
    operationalStatusQueryMock = {
      data: {
        state: "upgrading_assistant_version",
        detail_state: "failed",
        detail: { reason: "readiness_poll", message: null },
      },
      isError: false,
    };

    // WHEN the banner renders
    const html = renderToStaticMarkup(<StatusBanner />);

    // THEN it shows the failed title with error styling
    expect(html).toContain("Assistant upgrade failed");
    expect(html).not.toContain("Assistant is upgrading");
    expect(html).toContain('data-tone="error"');
    expect(html).toContain("bg-[var(--system-negative-weak)]");
    expect(html).toContain("lucide-triangle-alert");
    expect(html).not.toContain("animate-spin");

    // AND it shows both Doctor and Dismiss actions
    expect(html).toContain("Go to Doctor");
    expect(html).toContain("Dismiss");
  });

  test("surfaces the failure detail message when present", () => {
    operationalStatusQueryMock = {
      data: {
        state: "resizing_machine",
        detail_state: "failed",
        detail: { reason: "quota_exceeded", message: "Out of capacity" },
      },
      isError: false,
    };

    const html = renderToStaticMarkup(<StatusBanner />);

    expect(html).toContain("Machine resize failed");
    expect(html).toContain("Out of capacity");
    expect(html).toContain('data-tone="error"');
  });

  test("does not render Doctor action for local assistant failed operations but still shows Dismiss", () => {
    // GIVEN a local assistant whose upgrade has failed
    assistantStateMock = { kind: "active", isLocal: true };
    operationalStatusQueryMock = {
      data: {
        state: "upgrading_assistant_version",
        detail_state: "failed",
        detail: { reason: "readiness_poll", message: null },
      },
      isError: false,
    };

    // WHEN the banner renders
    const html = renderToStaticMarkup(<StatusBanner />);

    // THEN it shows the failed title with Dismiss but no Doctor
    expect(html).toContain("Assistant upgrade failed");
    expect(html).not.toContain("Go to Doctor");
    expect(html).toContain("Dismiss");
  });

  test("dismiss button hides the failed operation banner", async () => {
    /**
     * Clicking Dismiss on a failed-operation banner hides it until the
     * operational state changes.
     */

    // GIVEN a failed upgrade banner is visible
    operationalStatusQueryMock = {
      data: {
        state: "upgrading_assistant_version",
        detail_state: "failed",
        detail: { reason: "readiness_poll", message: null },
      },
      isError: false,
    };
    render(<StatusBanner />);
    expect(screen.getByText("Assistant upgrade failed")).toBeTruthy();

    // WHEN the user clicks Dismiss
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    // THEN the banner is hidden
    await waitFor(() => {
      expect(screen.queryByText("Assistant upgrade failed")).toBeNull();
    });
  });

  test("uses a blue pulsing dot for waking", () => {
    operationalStatusQueryMock = {
      data: { state: "waking" },
      isError: false,
    };

    const html = renderToStaticMarkup(<StatusBanner />);

    expect(html).toContain("Assistant is waking");
    expect(html).toContain('data-tone="info"');
    expect(html).toContain("busy-indicator");
    expect(html).not.toContain("animate-spin");
  });

  test("does not render Doctor action for local assistant operational errors", () => {
    assistantStateMock = { kind: "active", isLocal: true };
    operationalStatusQueryMock = {
      data: { state: "crash_loop" },
      isError: false,
    };

    const html = renderToStaticMarkup(<StatusBanner />);

    expect(html).toContain("Assistant is crashed");
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
    expect(html).toContain("Assistant is crashed");
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
    expect(sleepingHtml).toContain("bg-[var(--surface-active)]");

    operationalStatusQueryMock = {
      data: { state: "maintenance_mode" },
      isError: false,
    };

    const maintenanceHtml = renderToStaticMarkup(<StatusBanner />);

    expect(maintenanceHtml).toContain("Assistant is in maintenance mode");
    expect(maintenanceHtml).toContain('data-tone="warning"');
    expect(maintenanceHtml).toContain("Resume Assistant");
  });

  test("shows sleeping banner instead of unreachable when transitioning from active to unreachable", async () => {
    // GIVEN the operational status is active
    operationalStatusQueryMock = {
      data: { state: "active" },
      isError: false,
    };

    const { rerender } = render(<StatusBanner />);

    // WHEN the operational status transitions directly to unreachable
    operationalStatusQueryMock = {
      data: { state: "unreachable" },
      isError: false,
    };
    rerender(<StatusBanner />);

    // THEN the banner shows "sleeping" instead of "unreachable"
    await waitFor(() => {
      expect(screen.getByText("Assistant is sleeping")).toBeTruthy();
    });
    expect(screen.queryByText("Assistant is unreachable")).toBeNull();
  });

  test("renders maintenance mode from lifecycle state when operational status is absent", () => {
    assistantStateMock = {
      kind: "active",
      isLocal: false,
      maintenanceMode: { enabled: true },
    };

    const html = renderToStaticMarkup(<StatusBanner />);

    expect(html).toContain("Assistant is in maintenance mode");
    expect(html).toContain('data-tone="warning"');
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

    test("renders an info migrating banner while local DB migrations run", () => {
      localHealthMock = "migrating";

      const html = renderToStaticMarkup(<StatusBanner />);

      // In-progress info treatment, not the unhealthy warning — a migrating
      // daemon must not invite a mid-migration restart.
      expect(html).toContain("Assistant is migrating");
      expect(html).toContain('data-tone="info"');
      expect(html).not.toContain("Wake up");
    });

    test("renders an asleep banner with a wake action when the local assistant is sleeping", () => {
      localHealthMock = "sleeping";

      const html = renderToStaticMarkup(<StatusBanner />);

      expect(html).toContain("Your assistant is asleep");
      expect(html).toContain("Wake up");
      expect(html).toContain('data-tone="neutral"');
      expect(html).toContain("bg-[var(--surface-active)]");
      expect(html).toContain("items-center");
      expect(html).toContain("[&amp;_[data-slot=button]]:uppercase");
      expect(html).not.toContain(
        "[&amp;_[data-slot=button]]:hover:bg-[color-mix(in_srgb,var(--status-banner-action-color)_12%,transparent)]",
      );
      expect(html).not.toContain("[&amp;_[data-slot=button]]:hover:opacity-90");
    });

    test("renders unreachable local health as an asleep fallback", () => {
      localHealthMock = "unreachable";

      const html = renderToStaticMarkup(<StatusBanner />);

      expect(html).toContain("Your assistant is asleep");
      expect(html).toContain("Wake up");
      expect(html).toContain('data-tone="neutral"');
      expect(html).not.toContain("Your assistant is unreachable");
    });

    test("shows an informative, action-free banner when no local-mode host is available", () => {
      // Where local-mode operations aren't available, the banner must not offer
      // a "Wake up" button that can't work.
      localHealthMock = "unreachable";
      isLocalModeHostAvailableMock = false;

      const html = renderToStaticMarkup(<StatusBanner />);

      expect(html).toContain("Your assistant runs locally");
      expect(html).toContain("Open the Vellum desktop app");
      expect(html).not.toContain("Wake up");
      expect(html).toContain('data-tone="neutral"');
    });

    test("hides the Wake up button for an assistant vellum wake can't start (e.g. Docker)", () => {
      // Capable host, but the active assistant isn't CLI-wakeable (Docker /
      // apple-container) — offering "Wake up" would call `vellum wake`, which
      // refuses those. Show status without the button.
      localHealthMock = "unreachable";
      isLocalModeHostAvailableMock = true;
      isCliWakeableMock = false;

      const html = renderToStaticMarkup(<StatusBanner />);

      expect(html).toContain("Your assistant is asleep");
      expect(html).not.toContain("Wake up");
    });

    test("wakes the active local assistant from the banner action", async () => {
      localHealthMock = "sleeping";

      render(<StatusBanner />);
      fireEvent.click(screen.getByRole("button", { name: "Wake up" }));

      await waitFor(() => {
        expect(wakeLocalAssistantHostMock).toHaveBeenCalledWith(
          "assistant-123",
        );
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
      expect(html).toContain('data-tone="info"');
      expect(html).toContain("busy-indicator");
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
      expect(html).toContain('data-tone="error"');
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
      expect(html).toContain('data-tone="error"');
      expect(html).not.toContain("Assistant is crashed");
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
      expect(html).toContain('data-tone="error"');
      expect(html).not.toContain("Assistant is crashed");
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
      expect(html).toContain('data-tone="error"');
      expect(html).toContain("lucide-cloud-off");
      expect(html).not.toContain("Assistant is crashed");
    });

    test("does not render backend-unreachable connectivity state outside Electron", () => {
      connectivityStateMock = "backend-unreachable";

      const html = renderToStaticMarkup(<StatusBanner />);

      expect(html).toBe("");
    });
  });
});
