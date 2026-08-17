import type { NativeAuthCallback } from "@vellumai/electron-desktop/native-auth";

export interface WindowsAuthCallbackOptions {
  scheme: string;
  subscribe: (listener: (url: string) => void) => () => void;
}

const CALLBACK_HOST = "auth";
const CALLBACK_PATH = "/callback";

export function startWindowsAuthCallback(
  expectedState: string,
  options: WindowsAuthCallbackOptions,
): Promise<NativeAuthCallback> {
  let resolveCode: (code: string) => void = () => {};
  let rejectCode: (error: Error) => void = () => {};
  let unsubscribe = () => {};
  let settled = false;

  const waitForCode = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const finish = (result: { code: string } | { error: Error }): void => {
    if (settled) {
      return;
    }
    settled = true;
    unsubscribe();
    if ("code" in result) {
      resolveCode(result.code);
    } else {
      rejectCode(result.error);
    }
  };

  const onUrl = (input: string): void => {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      return;
    }
    if (
      url.protocol !== `${options.scheme}:` ||
      url.host !== CALLBACK_HOST ||
      url.pathname !== CALLBACK_PATH ||
      url.searchParams.get("state") !== expectedState
    ) {
      return;
    }

    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    if (error || !code) {
      const description = url.searchParams.get("error_description");
      const detail = description ? `${error}: ${description}` : error;
      finish({
        error: new Error(
          `Authentication failed: ${detail ?? "no authorization code received"}`,
        ),
      });
      return;
    }
    finish({ code });
  };

  const stop = options.subscribe(onUrl);
  unsubscribe = stop;
  if (settled) {
    stop();
  }

  return Promise.resolve({
    redirectUri: `${options.scheme}://${CALLBACK_HOST}${CALLBACK_PATH}`,
    waitForCode,
    close: (reason?: string) => {
      finish({ error: new Error(reason ?? "Auth flow cancelled.") });
    },
  });
}
