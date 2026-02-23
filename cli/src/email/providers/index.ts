/**
 * Email provider factory — creates a VellumProvider instance.
 *
 * Reads the API key from the VELLUM_API_KEY environment variable.
 */

import { VellumProvider } from "./vellum.js";

/**
 * Create the Vellum email provider instance.
 * Throws if the VELLUM_API_KEY environment variable is not set.
 */
export async function createProvider(): Promise<VellumProvider> {
  const apiKey = process.env.VELLUM_API_KEY;
  if (!apiKey) {
    throw new Error(
      "No Vellum API key configured. Set the VELLUM_API_KEY environment variable.",
    );
  }
  const baseUrl = process.env.VELLUM_API_URL ?? "https://api.vellum.ai";
  return new VellumProvider(apiKey, baseUrl);
}
