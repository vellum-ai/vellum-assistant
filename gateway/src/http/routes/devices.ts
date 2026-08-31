/**
 * Loopback-guarded device management for the local assistant.
 *
 *   GET  /v1/devices         — list devices paired to this assistant
 *   POST /v1/devices/revoke  — revoke a device's tokens (by hashedDeviceId)
 *
 * These are the host side of pairing lifecycle (the machine running the
 * assistant manages the devices paired to it). The gateway only ever stores the
 * HASHED device id, so list returns `hashedDeviceId` and revoke accepts the same
 * value — the raw deviceId is never persisted. Both endpoints scope strictly to
 * the local assistant's guardian principal.
 */

import { and, eq, max } from "drizzle-orm";

import {
  revokeActorTokensByDevice,
  revokeRefreshTokensByDevice,
} from "../../auth/guardian-bootstrap.js";
import { getGatewayDb } from "../../db/connection.js";
import { actorTokenRecords } from "../../db/schema.js";
import {
  enforceLoopbackOnly,
  errorResponse,
  rejectBrowserOrigin,
} from "../loopback-guard.js";
import { resolveLocalGuardianPrincipalId } from "./pair.js";

export async function handleListDevices(
  req: Request,
  clientIp: string,
): Promise<Response> {
  if (req.method !== "GET") {
    return new Response("method not allowed", {
      status: 405,
      headers: { Allow: "GET" },
    });
  }

  const guardError = enforceLoopbackOnly(req, clientIp, "devices");
  if (guardError) return guardError;
  const originError = rejectBrowserOrigin(req, clientIp, "devices");
  if (originError) return originError;

  const guardianPrincipalId = await resolveLocalGuardianPrincipalId();
  const db = getGatewayDb();

  // One active actor token per (principal, device) via the unique index, so
  // this already enumerates distinct devices.
  const tokens = db
    .select({
      hashedDeviceId: actorTokenRecords.hashedDeviceId,
      platform: actorTokenRecords.platform,
      pairingUserAgent: actorTokenRecords.pairingUserAgent,
      clientReportedName: actorTokenRecords.clientReportedName,
      issuedAt: actorTokenRecords.issuedAt,
      expiresAt: actorTokenRecords.expiresAt,
    })
    .from(actorTokenRecords)
    .where(
      and(
        eq(actorTokenRecords.guardianPrincipalId, guardianPrincipalId),
        eq(actorTokenRecords.status, "active"),
      ),
    )
    .all();

  // Refreshing credentials revokes the active row and mints an unstamped
  // replacement, so the newest stamp for a device can live on a revoked row.
  // Take the max across every status to keep activity history across rotation.
  // Same principal filter as above with no status filter, so every listed
  // device is covered by a group here.
  const lastUsedRows = db
    .select({
      hashedDeviceId: actorTokenRecords.hashedDeviceId,
      lastUsedAt: max(actorTokenRecords.lastUsedAt),
    })
    .from(actorTokenRecords)
    .where(eq(actorTokenRecords.guardianPrincipalId, guardianPrincipalId))
    .groupBy(actorTokenRecords.hashedDeviceId)
    .all();

  const lastUsedByDevice = new Map<string, number | null>(
    lastUsedRows.map((r) => [r.hashedDeviceId, r.lastUsedAt ?? null]),
  );

  const devices = tokens.map((t) => ({
    hashedDeviceId: t.hashedDeviceId,
    platform: t.platform,
    pairingUserAgent: t.pairingUserAgent ?? null,
    clientReportedName: t.clientReportedName ?? null,
    issuedAt: t.issuedAt,
    expiresAt: t.expiresAt ?? null,
    lastUsedAt: lastUsedByDevice.get(t.hashedDeviceId) ?? null,
  }));

  return Response.json({ devices });
}

export async function handleRevokeDevice(
  req: Request,
  clientIp: string,
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("method not allowed", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }

  const guardError = enforceLoopbackOnly(req, clientIp, "devices");
  if (guardError) return guardError;
  const originError = rejectBrowserOrigin(req, clientIp, "devices");
  if (originError) return originError;

  let body: { hashedDeviceId?: unknown };
  try {
    body = (await req.json()) as { hashedDeviceId?: unknown };
  } catch {
    body = {};
  }
  const hashedDeviceId =
    typeof body.hashedDeviceId === "string" ? body.hashedDeviceId.trim() : "";
  if (!hashedDeviceId) {
    return errorResponse("BAD_REQUEST", "hashedDeviceId is required", 400);
  }

  // Idempotent: revoking an unknown/already-revoked device is a no-op success.
  const guardianPrincipalId = await resolveLocalGuardianPrincipalId();
  revokeActorTokensByDevice(guardianPrincipalId, hashedDeviceId);
  revokeRefreshTokensByDevice(guardianPrincipalId, hashedDeviceId);

  return Response.json({ revoked: true, hashedDeviceId });
}
