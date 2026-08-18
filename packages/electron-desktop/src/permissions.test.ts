import { beforeEach, describe, expect, mock, test } from "bun:test";

type PermissionCheckHandler = NonNullable<
  Parameters<Electron.Session["setPermissionCheckHandler"]>[0]
>;
type PermissionRequestHandler = NonNullable<
  Parameters<Electron.Session["setPermissionRequestHandler"]>[0]
>;

let permissionCheckHandler: PermissionCheckHandler | null = null;
let permissionRequestHandler: PermissionRequestHandler | null = null;

const setPermissionCheckHandlerMock = mock(
  (handler: typeof permissionCheckHandler) => {
    permissionCheckHandler = handler;
  },
);
const setPermissionRequestHandlerMock = mock(
  (handler: typeof permissionRequestHandler) => {
    permissionRequestHandler = handler;
  },
);

mock.module("electron", () => ({
  app: { isPackaged: true },
  session: {
    defaultSession: {
      setPermissionCheckHandler: setPermissionCheckHandlerMock,
      setPermissionRequestHandler: setPermissionRequestHandlerMock,
    },
  },
}));

const permissionPolicy = await import("./permissions");
const {
  denyAllPermissions,
  installPermissionHandler,
} = permissionPolicy;

const allowedOrigin = { protocol: "app:", host: "vellum.ai" };
const resolveAllowedOrigin = () => allowedOrigin;
const shouldGrantPermissionCheck = (
  ...args: Parameters<typeof permissionPolicy.shouldGrantPermissionCheck> extends [
    infer Permission,
    infer Origin,
    infer Details,
    ...unknown[],
  ]
    ? [Permission, Origin, Details]
    : never
) => permissionPolicy.shouldGrantPermissionCheck(...args, allowedOrigin);
const shouldGrantPermissionRequest = (
  ...args: Parameters<typeof permissionPolicy.shouldGrantPermissionRequest> extends [
    infer Permission,
    infer Details,
    ...unknown[],
  ]
    ? [Permission, Details]
    : never
) => permissionPolicy.shouldGrantPermissionRequest(...args, allowedOrigin);

beforeEach(() => {
  permissionCheckHandler = null;
  permissionRequestHandler = null;
  setPermissionCheckHandlerMock.mockClear();
  setPermissionRequestHandlerMock.mockClear();
});

describe("permission policy", () => {
  test("allows audio-only media requests from the app renderer", () => {
    expect(
      shouldGrantPermissionRequest("media", {
        mediaTypes: ["audio"],
        securityOrigin: "app://vellum.ai",
      }),
    ).toBe(true);
  });

  test("allows camera and mixed capture requests from the app renderer", () => {
    // The voice room's viewfinder. Denying this does not degrade to asking:
    // Chromium refuses `getUserMedia` before macOS is consulted, so the camera
    // button would fail with a prompt the user never saw.
    expect(
      shouldGrantPermissionRequest("media", {
        mediaTypes: ["video"],
        securityOrigin: "app://vellum.ai",
      }),
    ).toBe(true);
    expect(
      shouldGrantPermissionRequest("media", {
        mediaTypes: ["audio", "video"],
        securityOrigin: "app://vellum.ai",
      }),
    ).toBe(true);
  });

  test("denies camera requests from untrusted origins", () => {
    expect(
      shouldGrantPermissionRequest("media", {
        mediaTypes: ["video"],
        securityOrigin: "https://example.com",
      }),
    ).toBe(false);
  });

  test("denies media requests carrying an unrecognized capture type", () => {
    // Audio and video are the two the product has designed for. Anything else
    // appearing in `mediaTypes` is a capture surface nobody has reviewed, and
    // it takes the whole request down rather than being ignored.
    expect(
      shouldGrantPermissionRequest("media", {
        mediaTypes: ["audio", "unknown"] as unknown as ("audio" | "video")[],
        securityOrigin: "app://vellum.ai",
      }),
    ).toBe(false);
  });

  test("denies audio requests from untrusted origins", () => {
    expect(
      shouldGrantPermissionRequest("media", {
        mediaTypes: ["audio"],
        securityOrigin: "https://example.com",
      }),
    ).toBe(false);
  });

  test("denies non-media permissions", () => {
    expect(
      shouldGrantPermissionRequest("notifications", {
        mediaTypes: ["audio"],
        securityOrigin: "app://vellum.ai",
      }),
    ).toBe(false);
  });

  test("allows clipboard-sanitized-write from the app renderer", () => {
    expect(
      shouldGrantPermissionRequest("clipboard-sanitized-write", {
        mediaTypes: [],
        securityOrigin: "app://vellum.ai",
      }),
    ).toBe(true);
  });

  test("denies clipboard-sanitized-write from untrusted origins", () => {
    expect(
      shouldGrantPermissionRequest("clipboard-sanitized-write", {
        mediaTypes: [],
        securityOrigin: "https://example.com",
      }),
    ).toBe(false);
  });

  test("allows matching audio permission checks", () => {
    expect(
      shouldGrantPermissionCheck("media", "app://vellum.ai", {
        mediaType: "audio",
      }),
    ).toBe(true);
  });

  test("allows video permission checks", () => {
    // Chromium runs the check before the request, so a `video` check that
    // fails here means the request handler above is never consulted and the
    // camera fails silently. The two must agree.
    expect(
      shouldGrantPermissionCheck("media", "app://vellum.ai", {
        mediaType: "video",
      }),
    ).toBe(true);
  });

  test("denies video permission checks from untrusted origins", () => {
    expect(
      shouldGrantPermissionCheck("media", "https://example.com", {
        mediaType: "video",
      }),
    ).toBe(false);
  });

  test("allows clipboard-sanitized-write checks from the app renderer", () => {
    expect(
      shouldGrantPermissionCheck(
        "clipboard-sanitized-write",
        "app://vellum.ai",
        {},
      ),
    ).toBe(true);
  });

  test("denies clipboard-sanitized-write checks from untrusted origins", () => {
    expect(
      shouldGrantPermissionCheck(
        "clipboard-sanitized-write",
        "https://example.com",
        {},
      ),
    ).toBe(false);
  });

  test("installs check and request handlers on the default session", () => {
    installPermissionHandler(resolveAllowedOrigin);

    expect(setPermissionCheckHandlerMock).toHaveBeenCalledTimes(1);
    expect(setPermissionRequestHandlerMock).toHaveBeenCalledTimes(1);
    expect(permissionCheckHandler).toBeTruthy();
    expect(permissionRequestHandler).toBeTruthy();
  });

  test("installed request handler grants renderer audio requests", () => {
    installPermissionHandler(resolveAllowedOrigin);

    const handler = permissionRequestHandler;
    if (!handler) throw new Error("expected permission request handler");

    let granted = false;
    handler(
      { getURL: () => "app://vellum.ai/assistant" } as Electron.WebContents,
      "media",
      (value) => {
        granted = value;
      },
      { mediaTypes: ["audio"] } as Electron.MediaAccessPermissionRequest,
    );

    expect(granted).toBe(true);
  });
});

describe("denyAllPermissions", () => {
  test("installs blanket deny handlers on the target session", () => {
    let requestHandler: ((...args: unknown[]) => void) | null = null;
    let checkHandler: ((...args: unknown[]) => boolean) | null = null;

    const targetSession = {
      setPermissionRequestHandler: mock((h: typeof requestHandler) => {
        requestHandler = h;
      }),
      setPermissionCheckHandler: mock((h: typeof checkHandler) => {
        checkHandler = h;
      }),
    };

    denyAllPermissions(targetSession as never);

    expect(targetSession.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    expect(targetSession.setPermissionCheckHandler).toHaveBeenCalledTimes(1);

    let granted = true;
    requestHandler!({}, "media", (allowed: boolean) => {
      granted = allowed;
    });
    expect(granted).toBe(false);

    expect(checkHandler!({}, "clipboard-read", "vellumapp://bundle")).toBe(
      false,
    );
  });
});
