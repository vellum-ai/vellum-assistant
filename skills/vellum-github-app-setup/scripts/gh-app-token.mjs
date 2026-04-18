#!/usr/bin/env bun
/**
 * Generate a GitHub App installation access token.
 *
 * Reads credentials from the assistant's encrypted vault and outputs
 * a short-lived installation token to stdout. Tokens expire after 1 hour.
 *
 * Usage:
 *   bun gh-app-token.mjs
 *
 * Configure git to use the token:
 *   git remote set-url origin "https://x-access-token:$(bun gh-app-token.mjs)@github.com/OWNER/REPO.git"
 *
 * Requires these credentials in the vault (service: github-app):
 *   - app_id
 *   - pem
 *   - installation_id
 */
import crypto from "crypto";
import { execSync } from "child_process";

const ALLOWED_FIELDS = new Set(["app_id", "pem", "installation_id"]);

function getCredential(field) {
  if (!ALLOWED_FIELDS.has(field)) {
    throw new Error(`Invalid credential field: ${field}`);
  }
  try {
    const value = execSync(`assistant credentials reveal --service github-app --field ${field}`, {
      timeout: 10_000,
    })
      .toString()
      .trim();
    if (!value) {
      throw new Error(`Empty value returned for github-app:${field}`);
    }
    return value;
  } catch (err) {
    console.error(`Failed to read credential github-app:${field}. Is it stored in the vault?`);
    console.error(`Run: assistant credentials list --search github-app`);
    process.exit(1);
  }
}

const appId = getCredential("app_id");
const pem = getCredential("pem");
const installationId = getCredential("installation_id");

// Generate JWT signed with the app's private key
const now = Math.floor(Date.now() / 1000);
const header = { alg: "RS256", typ: "JWT" };
const payload = { iat: now - 60, exp: now + 10 * 60, iss: appId };

function base64url(obj) {
  return Buffer.from(JSON.stringify(obj))
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

const headerB64 = base64url(header);
const payloadB64 = base64url(payload);
const sigInput = `${headerB64}.${payloadB64}`;
const sign = crypto.createSign("RSA-SHA256");
sign.update(sigInput);
const signature = sign
  .sign(pem, "base64")
  .replace(/=/g, "")
  .replace(/\+/g, "-")
  .replace(/\//g, "_");
const jwt = `${sigInput}.${signature}`;

// Exchange JWT for a short-lived installation token
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 15_000);

try {
  const resp = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
      },
      signal: controller.signal,
    }
  );

  const data = await resp.json();
  if (!data.token) {
    console.error("Failed to get installation token:", JSON.stringify(data));
    process.exit(1);
  }

  process.stdout.write(data.token);
} catch (err) {
  if (err.name === "AbortError") {
    console.error("Request timed out after 15s");
  } else {
    console.error("Failed to get installation token:", err.message);
  }
  process.exit(1);
} finally {
  clearTimeout(timeout);
}
