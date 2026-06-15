import { loopbackSafeFetch } from "./loopback-fetch.js";

interface PairingCodeResponse {
  code?: unknown;
  expiresAt?: unknown;
  expiresInSeconds?: unknown;
}

export interface RemoteWebPairingCode {
  code: string;
  expiresAt: string;
  expiresInSeconds: number;
}

function assistantUrl(publicUrl: string): string {
  return new URL("/assistant/", publicUrl).toString();
}

export async function createRemoteWebPairingCode(opts: {
  gatewayPort: number;
  publicBaseUrl: string;
}): Promise<RemoteWebPairingCode> {
  const res = await loopbackSafeFetch(
    `http://127.0.0.1:${opts.gatewayPort}/v1/remote-web/pairing-code`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicBaseUrl: opts.publicBaseUrl }),
      signal: AbortSignal.timeout(3_000),
    },
  );

  if (!res.ok) {
    throw new Error(`gateway returned ${res.status}`);
  }

  const body = (await res.json()) as PairingCodeResponse;
  if (
    typeof body.code !== "string" ||
    typeof body.expiresAt !== "string" ||
    typeof body.expiresInSeconds !== "number"
  ) {
    throw new Error("gateway returned an invalid pairing response");
  }

  return {
    code: body.code,
    expiresAt: body.expiresAt,
    expiresInSeconds: body.expiresInSeconds,
  };
}

export async function printRemoteWebPairingInstructions(opts: {
  gatewayPort: number;
  publicBaseUrl: string;
  enabled: boolean;
}): Promise<void> {
  if (!opts.enabled) return;

  try {
    const pairing = await createRemoteWebPairingCode({
      gatewayPort: opts.gatewayPort,
      publicBaseUrl: opts.publicBaseUrl,
    });

    console.log("");
    console.log(`Remote web app: ${assistantUrl(opts.publicBaseUrl)}`);
    console.log(`Pairing code:   ${pairing.code}`);
    console.log(
      `Code expires:   ${pairing.expiresAt} (${pairing.expiresInSeconds}s)`,
    );
  } catch (err) {
    console.warn("");
    console.warn(
      `Warning: could not create a remote web pairing code: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
