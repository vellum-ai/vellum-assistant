/**
 * CES RPC backend for non-secret credential records (identity + policy).
 */

import type { CredentialRecord } from "@vellumai/service-contracts/credential-rpc";
import { CesRpcMethod } from "@vellumai/service-contracts/credential-rpc";

import type { CesClient } from "../credential-execution/client.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("ces-rpc-record-backend");

export interface CredentialRecordBackend {
  isAvailable(): boolean;
  get(account: string): Promise<CredentialRecord | undefined>;
  set(account: string, record: CredentialRecord): Promise<boolean>;
  delete(account: string): Promise<"deleted" | "not-found" | "error">;
  /**
   * List all records. Returns `null` when CES cannot be reached so callers
   * can distinguish an outage from an empty catalog.
   */
  list(): Promise<Array<{
    account: string;
    record: CredentialRecord;
  }> | null>;
  bulkSet(
    records: Array<{ account: string; record: CredentialRecord }>,
  ): Promise<Array<{ account: string; ok: boolean }>>;
}

export class CesRpcRecordBackend implements CredentialRecordBackend {
  constructor(private readonly client: CesClient) {}

  isAvailable(): boolean {
    return this.client.isReady();
  }

  async get(account: string): Promise<CredentialRecord | undefined> {
    if (!this.isAvailable()) {
      return undefined;
    }
    try {
      const result = await this.client.call(CesRpcMethod.GetCredentialRecord, {
        account,
      });
      return result.found ? result.record : undefined;
    } catch (err) {
      log.warn({ err, account }, "CES RPC credential record get failed");
      return undefined;
    }
  }

  async set(account: string, record: CredentialRecord): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }
    try {
      const result = await this.client.call(CesRpcMethod.SetCredentialRecord, {
        account,
        record,
      });
      return result.ok;
    } catch (err) {
      log.warn({ err, account }, "CES RPC credential record set failed");
      return false;
    }
  }

  async delete(
    account: string,
  ): Promise<"deleted" | "not-found" | "error"> {
    if (!this.isAvailable()) {
      return "error";
    }
    try {
      const result = await this.client.call(
        CesRpcMethod.DeleteCredentialRecord,
        { account },
      );
      return result.result;
    } catch (err) {
      log.warn({ err, account }, "CES RPC credential record delete failed");
      return "error";
    }
  }

  async list(): Promise<Array<{
    account: string;
    record: CredentialRecord;
  }> | null> {
    if (!this.isAvailable()) {
      return null;
    }
    try {
      const result = await this.client.call(
        CesRpcMethod.ListCredentialRecords,
        {},
      );
      return result.records ?? [];
    } catch (err) {
      log.warn({ err }, "CES RPC credential record list failed");
      return null;
    }
  }

  async bulkSet(
    records: Array<{ account: string; record: CredentialRecord }>,
  ): Promise<Array<{ account: string; ok: boolean }>> {
    if (!this.isAvailable()) {
      return records.map((entry) => ({ account: entry.account, ok: false }));
    }
    try {
      const result = await this.client.call(
        CesRpcMethod.BulkSetCredentialRecords,
        { records },
      );
      return result.results;
    } catch (err) {
      log.warn({ err }, "CES RPC credential record bulk set failed");
      return records.map((entry) => ({ account: entry.account, ok: false }));
    }
  }
}
