import { existsSync } from 'node:fs';

export interface BrowserRuntimeStatus {
  playwrightAvailable: boolean;
  chromiumInstalled: boolean;
  chromiumPath: string | null;
  error: string | null;
}

export async function checkBrowserRuntime(): Promise<BrowserRuntimeStatus> {
  // Check if playwright can be imported
  let chromium: { executablePath: () => string };
  try {
    const pw = await import('playwright');
    chromium = pw.chromium;
  } catch {
    return {
      playwrightAvailable: false,
      chromiumInstalled: false,
      chromiumPath: null,
      error: 'playwright package not available',
    };
  }

  // Check if Chromium browser is installed
  try {
    const execPath = chromium.executablePath();
    const installed = existsSync(execPath);
    return {
      playwrightAvailable: true,
      chromiumInstalled: installed,
      chromiumPath: installed ? execPath : null,
      error: installed ? null : `Chromium not found at ${execPath}. Run: bunx playwright install chromium`,
    };
  } catch (err) {
    return {
      playwrightAvailable: true,
      chromiumInstalled: false,
      chromiumPath: null,
      error: err instanceof Error ? err.message : 'Failed to check Chromium install',
    };
  }
}
