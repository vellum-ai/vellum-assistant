import { readFileSync } from "fs";
import jsQR from "jsqr";
import { PNG } from "pngjs";

import { saveAssistantEntry } from "../lib/assistant-config";
import type { AssistantEntry } from "../lib/assistant-config";
import type { Species } from "../lib/constants";
import { generateRandomSuffix } from "../lib/random-name";

interface QRPairingPayload {
  type: string;
  v: number;
  id?: string;
  g: string;
  pairingRequestId: string;
  pairingSecret: string;
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

export async function pair(): Promise<void> {
  const args = process.argv.slice(3);
  const qrCodePath = args[0] || process.env.VELLUM_CUSTOM_QR_CODE_PATH;

  if (!qrCodePath) {
    console.error("Usage: vellum pair <path-to-qrcode.png>");
    console.error("");
    console.error("Pair with a remote assistant by scanning the QR code PNG generated during setup.");
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

    if (payload.type !== "vellum-daemon" || !payload.g || !payload.pairingRequestId || !payload.pairingSecret) {
      throw new Error("QR code does not contain valid Vellum pairing data.");
    }

    const instanceName = `${species}-${generateRandomSuffix()}`;
    const runtimeUrl = payload.g;

    console.log(`Pairing with remote assistant at ${runtimeUrl}...`);

    const approveUrl = `${runtimeUrl}/v1/pairing/approve`;
    const approveRes = await fetch(approveUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairingRequestId: payload.pairingRequestId,
        pairingSecret: payload.pairingSecret,
      }),
    });

    if (!approveRes.ok) {
      const body = await approveRes.text().catch(() => "");
      throw new Error(`Failed to pair with remote assistant: HTTP ${approveRes.status}: ${body || approveRes.statusText}`);
    }

    const customEntry: AssistantEntry = {
      assistantId: instanceName,
      runtimeUrl,
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
