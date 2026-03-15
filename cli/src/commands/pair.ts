import { createHash } from "crypto";
import { readFileSync } from "fs";
import jsQR from "jsqr";
import { hostname, userInfo } from "os";
import { PNG } from "pngjs";

import { saveAssistantEntry } from "../lib/assistant-config";
import type { AssistantEntry } from "../lib/assistant-config";
import type { Species } from "../lib/constants";
import { generateInstanceName } from "../lib/random-name";

interface QRPairingPayload {
  type: string;
  v: number;
  id?: string;
  g: string;
  pairingRequestId: string;
  pairingSecret: string;
}

interface PairingResponse {
  status: "approved" | "pending";
  bearerToken?: string;
  gatewayUrl?: string;
}

function decodeQRCodeFromPng(pngPath: string): string {
  const fileData = readFileSync(pngPath);
  const png = PNG.sync.read(fileData);
  const code = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  if (!code) {
    throw new Error("Could not decode QR code from the provided PNG image.");
  }
  return code.data;
}

function getDeviceId(): string {
  const raw = hostname() + userInfo().username;
  return createHash("sha256").update(raw).digest("hex");
}

const PAIRING_POLL_INTERVAL_MS = 2000;
const PAIRING_POLL_TIMEOUT_MS = 120_000;

async function pollForApproval(
  gatewayUrl: string,
  pairingRequestId: string,
  pairingSecret: string,
): Promise<PairingResponse> {
  const startTime = Date.now();

  while (Date.now() - startTime < PAIRING_POLL_TIMEOUT_MS) {
    const statusUrl = `${gatewayUrl}/pairing/status?id=${encodeURIComponent(pairingRequestId)}&secret=${encodeURIComponent(pairingSecret)}`;
    const statusRes = await fetch(statusUrl);

    if (!statusRes.ok) {
      const body = await statusRes.text().catch(() => "");
      throw new Error(
        `Failed to check pairing status: HTTP ${statusRes.status}: ${body || statusRes.statusText}`,
      );
    }

    const statusBody = (await statusRes.json()) as PairingResponse;

    if (statusBody.status === "approved") {
      return statusBody;
    }

    await new Promise((resolve) =>
      setTimeout(resolve, PAIRING_POLL_INTERVAL_MS),
    );
  }

  throw new Error("Pairing timed out waiting for approval.");
}

export async function pair(): Promise<void> {
  const args = process.argv.slice(3);

  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: vellum pair <path-to-qrcode.png>");
    console.log("");
    console.log(
      "Pair with a remote assistant by scanning the QR code PNG generated during setup.",
    );
    process.exit(0);
  }

  const qrCodePath = args[0] || process.env.VELLUM_CUSTOM_QR_CODE_PATH;

  if (!qrCodePath) {
    console.error("Usage: vellum pair <path-to-qrcode.png>");
    console.error("");
    console.error(
      "Pair with a remote assistant by scanning the QR code PNG generated during setup.",
    );
    process.exit(1);
  }

  const species: Species = "vellum";

  try {
    console.log("Reading QR code from provided image...");
    const qrData = decodeQRCodeFromPng(qrCodePath);

    let payload: QRPairingPayload;
    try {
      payload = JSON.parse(qrData) as QRPairingPayload;
    } catch {
      throw new Error("QR code does not contain valid pairing data.");
    }

    if (
      payload.type !== "vellum-daemon" ||
      !payload.g ||
      !payload.pairingRequestId ||
      !payload.pairingSecret
    ) {
      throw new Error("QR code does not contain valid Vellum pairing data.");
    }

    const instanceName = generateInstanceName(species);
    const runtimeUrl = payload.g;
    const deviceId = getDeviceId();
    const deviceName = hostname();

    console.log(`Pairing with remote assistant at ${runtimeUrl}...`);

    const requestUrl = `${runtimeUrl}/pairing/request`;
    const requestRes = await fetch(requestUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairingRequestId: payload.pairingRequestId,
        pairingSecret: payload.pairingSecret,
        deviceId,
        deviceName,
      }),
    });

    if (!requestRes.ok) {
      const body = await requestRes.text().catch(() => "");
      throw new Error(
        `Failed to initiate pairing: HTTP ${requestRes.status}: ${body || requestRes.statusText}`,
      );
    }

    const requestBody = (await requestRes.json()) as PairingResponse;

    let bearerToken: string | undefined;

    if (requestBody.status === "approved") {
      bearerToken = requestBody.bearerToken;
    } else if (requestBody.status === "pending") {
      console.log("Waiting for pairing approval...");
      const approvedResponse = await pollForApproval(
        runtimeUrl,
        payload.pairingRequestId,
        payload.pairingSecret,
      );
      bearerToken = approvedResponse.bearerToken;
    } else {
      throw new Error(
        `Unexpected pairing response status: ${requestBody.status}`,
      );
    }

    const customEntry: AssistantEntry = {
      assistantId: instanceName,
      runtimeUrl,
      bearerToken,
      cloud: "custom",
      species,
      hatchedAt: new Date().toISOString(),
    };
    saveAssistantEntry(customEntry);

    console.log("");
    console.log("Successfully paired with remote assistant!");
    console.log("Instance details:");
    console.log(`  Name: ${instanceName}`);
    console.log(`  Runtime URL: ${runtimeUrl}`);
    console.log("");
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
