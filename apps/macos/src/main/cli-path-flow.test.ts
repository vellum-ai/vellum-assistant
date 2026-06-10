import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { CliPathInstallState } from "./cli-path-installer";

// ---------------------------------------------------------------------------
// Stubs and mocks
// ---------------------------------------------------------------------------

const WRAPPER_PATH = "/Users/test/.local/bin/vellum";
const PATH_EXPORT_LINE = 'export PATH="$HOME/.local/bin:$PATH"';

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

const getCliPathInstallStateMock = mock(
  async (): Promise<CliPathInstallState> => ({
    kind: "installed",
    inPath: true,
  }),
);
const installWrapperMock = mock(
  (_opts: { overwriteForeign: boolean }): "installed" | "needs-overwrite-confirmation" =>
    "installed",
);
const uninstallWrapperMock = mock(
  (): "removed" | "not-ours" | "absent" => "removed",
);

mock.module("./cli-path-installer", () => ({
  getCliPathInstallState: getCliPathInstallStateMock,
  installWrapper: installWrapperMock,
  uninstallWrapper: uninstallWrapperMock,
  getWrapperPath: () => WRAPPER_PATH,
  getWrapperDir: () => "/Users/test/.local/bin",
}));

const { runInstallCliCommandFlow, runUninstallCliCommandFlow } = await import(
  "./cli-path-flow"
);

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
  getCliPathInstallStateMock.mockReset();
  installWrapperMock.mockReset();
  uninstallWrapperMock.mockReset();

  showMessageBoxMock.mockResolvedValue({ response: 0, checkboxChecked: false });
  setState({ kind: "installed", inPath: true });
  installWrapperMock.mockReturnValue("installed");
  uninstallWrapperMock.mockReturnValue("removed");
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runInstallCliCommandFlow", () => {
  test("foreign file + Cancel leaves the file untouched", async () => {
    setState({ kind: "foreign-file" });
    showMessageBoxMock.mockResolvedValue({ response: 1, checkboxChecked: false });

    await runInstallCliCommandFlow();

    expect(showMessageBoxMock).toHaveBeenCalledTimes(1);
    expect(showMessageBoxMock.mock.calls[0]?.[0]?.message).toBe(
      "Replace existing vellum file?",
    );
    expect(installWrapperMock).not.toHaveBeenCalled();
  });

  test("foreign file + Replace installs with overwriteForeign", async () => {
    getCliPathInstallStateMock
      .mockResolvedValueOnce({ kind: "foreign-file" })
      .mockResolvedValueOnce({ kind: "installed", inPath: true });

    await runInstallCliCommandFlow();

    expect(installWrapperMock).toHaveBeenCalledTimes(1);
    expect(installWrapperMock).toHaveBeenCalledWith({ overwriteForeign: true });
  });

  test("installed + inPath shows success without touching the clipboard", async () => {
    setState({ kind: "installed", inPath: true });

    await runInstallCliCommandFlow();

    expect(installWrapperMock).toHaveBeenCalledWith({ overwriteForeign: false });
    expect(writeTextMock).not.toHaveBeenCalled();
    expect(lastDialog()?.message).toBe("Vellum CLI installed");
    expect(lastDialog()?.detail).toContain(WRAPPER_PATH);
    expect(lastDialog()?.detail).toContain('run "vellum"');
  });

  test("installed but not in PATH copies the export line to the clipboard", async () => {
    setState({ kind: "installed", inPath: false });

    await runInstallCliCommandFlow();

    expect(writeTextMock).toHaveBeenCalledTimes(1);
    expect(writeTextMock).toHaveBeenCalledWith(PATH_EXPORT_LINE);
    expect(lastDialog()?.detail).toContain("copied to your clipboard");
    expect(lastDialog()?.detail).toContain(WRAPPER_PATH);
  });

  test("shadowed names the winning binary and the npm uninstall fix", async () => {
    setState({ kind: "shadowed", shadowedBy: "/opt/homebrew/bin/vellum" });

    await runInstallCliCommandFlow();

    expect(writeTextMock).not.toHaveBeenCalled();
    expect(lastDialog()?.detail).toContain("/opt/homebrew/bin/vellum");
    expect(lastDialog()?.detail).toContain("npm uninstall -g vellum");
  });

  test("install race returning needs-overwrite-confirmation re-confirms once", async () => {
    setState({ kind: "installed", inPath: true });
    installWrapperMock
      .mockReturnValueOnce("needs-overwrite-confirmation")
      .mockReturnValueOnce("installed");

    await runInstallCliCommandFlow();

    expect(installWrapperMock).toHaveBeenCalledTimes(2);
    expect(installWrapperMock.mock.calls[1]?.[0]).toEqual({
      overwriteForeign: true,
    });
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
