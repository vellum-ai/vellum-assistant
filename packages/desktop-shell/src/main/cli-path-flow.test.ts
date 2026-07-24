import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { CliPathInstallState } from "./cli-path-installer";

// ---------------------------------------------------------------------------
// Stubs and mocks
// ---------------------------------------------------------------------------

const WRAPPER_PATH = "/Users/test/.local/bin/vellum";
const PATH_EXPORT_LINE = 'export PATH="$HOME/.local/bin:$PATH"';
const FISH_ADD_PATH_LINE = 'fish_add_path "$HOME/.local/bin"';

const showMessageBoxMock = mock(
  async (_opts: { message: string; detail?: string }) => ({
    response: 0,
    checkboxChecked: false,
  }),
);
const showErrorBoxMock = mock((_title: string, _content: string) => undefined);
const writeTextMock = mock((_text: string) => undefined);

mock.module("electron", () => ({
  dialog: {
    showMessageBox: showMessageBoxMock,
    showErrorBox: showErrorBoxMock,
  },
  clipboard: { writeText: writeTextMock },
}));

const ensureCliInstalledMock = mock(async (): Promise<void> => undefined);

mock.module("./cli-installer", () => ({
  ensureCliInstalled: ensureCliInstalledMock,
}));

const getCliPathInstallStateMock = mock(
  async (): Promise<CliPathInstallState> => ({
    kind: "installed",
    inPath: true,
    runtimeReady: true,
  }),
);
const installWrapperMock = mock(
  (_opts: { overwriteForeign: boolean }): "installed" | "needs-overwrite-confirmation" =>
    "installed",
);
const uninstallWrapperMock = mock(
  (): "removed" | "not-ours" | "absent" => "removed",
);

const isFishShellMock = mock((): boolean => false);

mock.module("./shell-path", () => ({
  isFishShell: isFishShellMock,
}));

mock.module("./cli-path-installer", () => ({
  getCliPathInstallState: getCliPathInstallStateMock,
  installWrapper: installWrapperMock,
  uninstallWrapper: uninstallWrapperMock,
  getWrapperPath: () => WRAPPER_PATH,
  getWrapperDir: () => "/Users/test/.local/bin",
}));

const {
  runInstallCliCommandFlow,
  runUninstallCliCommandFlow,
  isCliPathFlowInFlight,
} = await import("./cli-path-flow");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const setState = (state: CliPathInstallState) => {
  getCliPathInstallStateMock.mockResolvedValue(state);
};

const lastDialog = () => showMessageBoxMock.mock.calls.at(-1)?.[0];

beforeEach(() => {
  showMessageBoxMock.mockReset();
  showErrorBoxMock.mockClear();
  writeTextMock.mockClear();
  ensureCliInstalledMock.mockReset();
  getCliPathInstallStateMock.mockReset();
  installWrapperMock.mockReset();
  uninstallWrapperMock.mockReset();
  isFishShellMock.mockReset();

  showMessageBoxMock.mockResolvedValue({ response: 0, checkboxChecked: false });
  isFishShellMock.mockReturnValue(false);
  ensureCliInstalledMock.mockResolvedValue(undefined);
  setState({ kind: "installed", inPath: true, runtimeReady: true });
  installWrapperMock.mockReturnValue("installed");
  uninstallWrapperMock.mockReturnValue("removed");
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runInstallCliCommandFlow", () => {
  test("foreign file + Cancel leaves the file untouched", async () => {
    installWrapperMock.mockReturnValue("needs-overwrite-confirmation");
    showMessageBoxMock.mockResolvedValue({ response: 1, checkboxChecked: false });

    await runInstallCliCommandFlow();

    expect(showMessageBoxMock).toHaveBeenCalledTimes(1);
    expect(showMessageBoxMock.mock.calls[0]?.[0]?.message).toBe(
      "Replace existing vellum file?",
    );
    expect(installWrapperMock).toHaveBeenCalledTimes(1);
    expect(installWrapperMock).toHaveBeenCalledWith({ overwriteForeign: false });
    expect(ensureCliInstalledMock).not.toHaveBeenCalled();
  });

  test("foreign file + Replace retries with overwriteForeign", async () => {
    installWrapperMock
      .mockReturnValueOnce("needs-overwrite-confirmation")
      .mockReturnValueOnce("installed");

    await runInstallCliCommandFlow();

    expect(installWrapperMock).toHaveBeenCalledTimes(2);
    expect(installWrapperMock.mock.calls[0]?.[0]).toEqual({
      overwriteForeign: false,
    });
    expect(installWrapperMock.mock.calls[1]?.[0]).toEqual({
      overwriteForeign: true,
    });
    expect(ensureCliInstalledMock).toHaveBeenCalledTimes(1);
  });

  test("provisions the CLI runtime before showing success", async () => {
    setState({ kind: "installed", inPath: true, runtimeReady: true });

    await runInstallCliCommandFlow();

    expect(ensureCliInstalledMock).toHaveBeenCalledTimes(1);
    // State is only checked once, after install, for the success dialog.
    expect(getCliPathInstallStateMock).toHaveBeenCalledTimes(1);
    expect(lastDialog()?.message).toBe("Vellum CLI installed");
  });

  test("CLI runtime download failure points at the Repair menu item", async () => {
    ensureCliInstalledMock.mockRejectedValue(new Error("registry unreachable"));

    await runInstallCliCommandFlow();

    expect(showMessageBoxMock).not.toHaveBeenCalled();
    expect(showErrorBoxMock).toHaveBeenCalledTimes(1);
    const [title, message] = showErrorBoxMock.mock.calls[0]!;
    expect(title).toBe("Failed to install vellum command");
    expect(message).toContain(`The vellum command was installed at ${WRAPPER_PATH}`);
    expect(message).toContain("registry unreachable");
    expect(message).toContain('"Repair vellum Command"');
    expect(message).toContain("retried automatically");
  });

  test("installed + inPath shows success without touching the clipboard", async () => {
    setState({ kind: "installed", inPath: true, runtimeReady: true });

    await runInstallCliCommandFlow();

    expect(installWrapperMock).toHaveBeenCalledWith({ overwriteForeign: false });
    expect(writeTextMock).not.toHaveBeenCalled();
    expect(lastDialog()?.message).toBe("Vellum CLI installed");
    expect(lastDialog()?.detail).toContain(WRAPPER_PATH);
    expect(lastDialog()?.detail).toContain('run "vellum"');
  });

  test("installed but not in PATH copies the export line to the clipboard", async () => {
    setState({ kind: "installed", inPath: false, runtimeReady: true });

    await runInstallCliCommandFlow();

    expect(writeTextMock).toHaveBeenCalledTimes(1);
    expect(writeTextMock).toHaveBeenCalledWith(PATH_EXPORT_LINE);
    expect(lastDialog()?.detail).toContain("copied to your clipboard");
    expect(lastDialog()?.detail).toContain(WRAPPER_PATH);
  });

  test("installed but not in PATH copies fish_add_path for fish shells", async () => {
    isFishShellMock.mockReturnValue(true);
    setState({ kind: "installed", inPath: false, runtimeReady: true });

    await runInstallCliCommandFlow();

    expect(writeTextMock).toHaveBeenCalledTimes(1);
    expect(writeTextMock).toHaveBeenCalledWith(FISH_ADD_PATH_LINE);
    expect(lastDialog()?.detail).toContain("fish command");
    expect(lastDialog()?.detail).toContain("copied to your clipboard");
    expect(lastDialog()?.detail).not.toContain("shell profile");
  });

  test("shadowed + inPath names the winning binary and the npm uninstall fix", async () => {
    setState({
      kind: "shadowed",
      shadowedBy: "/opt/homebrew/bin/vellum",
      inPath: true,
      runtimeReady: true,
    });

    await runInstallCliCommandFlow();

    expect(writeTextMock).not.toHaveBeenCalled();
    expect(lastDialog()?.detail).toContain("/opt/homebrew/bin/vellum");
    expect(lastDialog()?.detail).toContain("npm uninstall -g vellum");
    expect(lastDialog()?.detail).not.toContain("clipboard");
  });

  test("shadowed without PATH adds the export-line help alongside the npm advice", async () => {
    setState({
      kind: "shadowed",
      shadowedBy: "/opt/homebrew/bin/vellum",
      inPath: false,
      runtimeReady: true,
    });

    await runInstallCliCommandFlow();

    expect(writeTextMock).toHaveBeenCalledTimes(1);
    expect(writeTextMock).toHaveBeenCalledWith(PATH_EXPORT_LINE);
    expect(lastDialog()?.detail).toContain("npm uninstall -g vellum");
    expect(lastDialog()?.detail).toContain("copied to your clipboard");
  });

  test("shadowed without PATH copies fish_add_path for fish shells", async () => {
    isFishShellMock.mockReturnValue(true);
    setState({
      kind: "shadowed",
      shadowedBy: "/opt/homebrew/bin/vellum",
      inPath: false,
      runtimeReady: true,
    });

    await runInstallCliCommandFlow();

    expect(writeTextMock).toHaveBeenCalledTimes(1);
    expect(writeTextMock).toHaveBeenCalledWith(FISH_ADD_PATH_LINE);
    expect(lastDialog()?.detail).toContain("npm uninstall -g vellum");
    expect(lastDialog()?.detail).toContain("fish command");
  });

  test("state check throwing surfaces via showErrorBox without rejecting", async () => {
    getCliPathInstallStateMock.mockRejectedValue(new Error("boom"));

    await runInstallCliCommandFlow();

    expect(showErrorBoxMock).toHaveBeenCalledTimes(1);
    expect(showErrorBoxMock).toHaveBeenCalledWith(
      "Failed to install vellum command",
      "boom",
    );
  });
});

describe("runUninstallCliCommandFlow", () => {
  test("Cancel skips uninstallWrapper", async () => {
    showMessageBoxMock.mockResolvedValue({ response: 1, checkboxChecked: false });

    await runUninstallCliCommandFlow();

    expect(showMessageBoxMock.mock.calls[0]?.[0]?.message).toBe(
      "Uninstall vellum command?",
    );
    expect(uninstallWrapperMock).not.toHaveBeenCalled();
  });

  test("removed shows the removal confirmation", async () => {
    uninstallWrapperMock.mockReturnValue("removed");

    await runUninstallCliCommandFlow();

    expect(uninstallWrapperMock).toHaveBeenCalledTimes(1);
    expect(lastDialog()?.detail).toBe("The vellum command was removed.");
  });

  test("not-ours refuses to remove a foreign file", async () => {
    uninstallWrapperMock.mockReturnValue("not-ours");

    await runUninstallCliCommandFlow();

    expect(lastDialog()?.detail).toContain("wasn't installed by Vellum");
    expect(lastDialog()?.detail).toContain("not removing it");
  });

  test("absent reports nothing to uninstall", async () => {
    uninstallWrapperMock.mockReturnValue("absent");

    await runUninstallCliCommandFlow();

    expect(lastDialog()?.detail).toBe("The vellum command is not installed.");
  });

  test("uninstallWrapper throwing surfaces via showErrorBox", async () => {
    uninstallWrapperMock.mockImplementation(() => {
      throw new Error("eperm");
    });

    await runUninstallCliCommandFlow();

    expect(showErrorBoxMock).toHaveBeenCalledWith(
      "Failed to uninstall vellum command",
      "eperm",
    );
  });
});

describe("flow re-entrancy guard", () => {
  // Parks the install flow at the (unbounded) CLI download step.
  const parkInstallFlow = () => {
    let release!: () => void;
    ensureCliInstalledMock.mockImplementation(
      () => new Promise<void>((resolve) => { release = resolve; }),
    );
    const flow = runInstallCliCommandFlow();
    return { flow, release: () => release() };
  };

  test("a second install invocation during an in-flight flow is a no-op", async () => {
    const { flow, release } = parkInstallFlow();
    expect(isCliPathFlowInFlight()).toBe(true);

    await runInstallCliCommandFlow();
    expect(installWrapperMock).toHaveBeenCalledTimes(1);

    release();
    await flow;
    expect(isCliPathFlowInFlight()).toBe(false);
    expect(installWrapperMock).toHaveBeenCalledTimes(1);
  });

  test("uninstall is blocked while an install flow is in flight (shared guard)", async () => {
    const { flow, release } = parkInstallFlow();

    await runUninstallCliCommandFlow();
    expect(uninstallWrapperMock).not.toHaveBeenCalled();
    expect(showMessageBoxMock).not.toHaveBeenCalled();

    release();
    await flow;
  });

  test("the guard is released after a failing flow", async () => {
    ensureCliInstalledMock.mockRejectedValue(new Error("offline"));
    await runInstallCliCommandFlow();
    expect(isCliPathFlowInFlight()).toBe(false);

    ensureCliInstalledMock.mockResolvedValue(undefined);
    await runInstallCliCommandFlow();
    expect(installWrapperMock).toHaveBeenCalledTimes(2);
  });
});
