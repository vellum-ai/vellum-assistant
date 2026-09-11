/**
 * CES HTTP backend for non-secret credential records (identity + policy).
 *
 * Used when the CES RPC socket is down but the CES HTTP sidecar is
 * reachable (containerized deployments with CES_CREDENTIAL_URL).
 */

import {
  type CesHttpCredentialClient,
  createCesHttpCredentialClient,
} from "@vellumai/ces-client/http-credentials";
import type { CredentialRecord } from "@vellumai/service-contracts/credential-rpc";

import { getIsContainerized } from "../config/env-registry.js";
import { getLogger } from "../util/logger.js";
import type { CredentialRecordBackend } from "./ces-rpc-record-backend.js";

const log = getLogger("ces-http-record-backend");

type RecordHttpClient = Pick<
  CesHttpCredentialClient,
  | "getRecord"
  | "setRecord"
  | "deleteRecord"
  | "listRecords"
  | "bulkSetRecords"
>;

function resolveEnvHttpClient(): RecordHttpClient | undefined {
  const baseUrl = process.env.CES_CREDENTIAL_URL?.trim();
  const serviceToken = process.env.CES_SERVICE_TOKEN?.trim();
  if (!baseUrl || !serviceToken) {
    return undefined;
  }
  return createCesHttpCredentialClient({ baseUrl, serviceToken }, log);
}

export class CesHttpRecordBackend implements CredentialRecordBackend {
  readonly name = "ces-http";

  constructor(private readonly client?: RecordHttpClient) {}

  private resolveClient(): RecordHttpClient | undefined {
    return this.client ?? resolveEnvHttpClient();
  }

  isAvailable(): boolean {
    return this.resolveClient() !== undefined;
  }

  async get(account: string): Promise<CredentialRecord | undefined> {
    const client = this.resolveClient();
    if (!client) {
      return undefined;
    }
    const result = await client.getRecord(account);
    return result.record;
  }

  async set(account: string, record: CredentialRecord): Promise<boolean> {
    const client = this.resolveClient();
    if (!client) {
      return false;
    }
    return client.setRecord(account, record);
  }

  async delete(
    account: string,
  ): Promise<"deleted" | "not-found" | "error"> {
    const client = this.resolveClient();
    if (!client) {
      return "error";
    }
    return client.deleteRecord(account);
  }

  async list(): Promise<Array<{
    account: string;
    record: CredentialRecord;
  }> | null> {
    const client = this.resolveClient();
    if (!client) {
      return null;
    }
    const result = await client.listRecords();
    if (result.unreachable) {
      return null;
    }
    return result.records ?? [];
  }

  async bulkSet(
    records: Array<{ account: string; record: CredentialRecord }>,
  ): Promise<Array<{ account: string; ok: boolean }>> {
    const client = this.resolveClient();
    if (!client) {
      return records.map((entry) => ({ account: entry.account, ok: false }));
    }
    return client.bulkSetRecords(records);
  }
}

/**
 * CES HTTP record backend when the assistant is containerized and the
 * CES HTTP sidecar URL is configured. Returns null otherwise.
 */
export function createCesHttpRecordBackendIfConfigured(): CredentialRecordBackend | null {
  if (!getIsContainerized()) {
    return null;
  }
  if (!process.env.CES_CREDENTIAL_URL?.trim()) {
    return null;
  }
  const backend = new CesHttpRecordBackend();
  if (!backend.isAvailable()) {
    return null;
  }
  return backend;
}
