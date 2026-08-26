/**
 * CES-owned credential record store.
 *
 * Persists non-secret identity and policy (`allowedTools`, `allowedDomains`,
 * `injectionTemplates`, plus catalog fields) at
 * `<cesDataRoot>/credential-records.json`. Secret values stay in `keys.enc`.
 */

import { join } from "node:path";

import {
  credentialKey,
  parseCredentialAccount,
  StaticCredentialMetadataStore,
} from "@vellumai/credential-storage";
import type { CredentialRecord } from "@vellumai/service-contracts/credential-rpc";

export const CREDENTIAL_RECORDS_FILENAME = "credential-records.json";

export function getCredentialRecordsPath(cesDataRoot: string): string {
  return join(cesDataRoot, CREDENTIAL_RECORDS_FILENAME);
}

export function accountForRecord(
  record: Pick<CredentialRecord, "service" | "field">,
): string {
  return credentialKey(record.service, record.field);
}

export class CesCredentialRecordStore {
  private readonly store: StaticCredentialMetadataStore;

  constructor(recordsPath: string) {
    this.store = new StaticCredentialMetadataStore(recordsPath);
  }

  getPath(): string {
    return this.store.getPath();
  }

  getByAccount(account: string): CredentialRecord | undefined {
    const parsed = parseCredentialAccount(account);
    if (!parsed) {
      return undefined;
    }
    return this.store.getByServiceField(parsed.service, parsed.field) as
      | CredentialRecord
      | undefined;
  }

  setByAccount(account: string, record: CredentialRecord): boolean {
    const parsed = parseCredentialAccount(account);
    if (!parsed) {
      return false;
    }
    if (parsed.service !== record.service || parsed.field !== record.field) {
      return false;
    }
    this.store.put(record);
    return true;
  }

  deleteByAccount(account: string): "deleted" | "not-found" | "error" {
    const parsed = parseCredentialAccount(account);
    if (!parsed) {
      return "error";
    }
    const existed = this.store.delete(parsed.service, parsed.field);
    return existed ? "deleted" : "not-found";
  }

  list(): Array<{ account: string; record: CredentialRecord }> {
    return this.store.list().map((record) => ({
      account: accountForRecord(record),
      record: record as CredentialRecord,
    }));
  }
}
