/**
 * CesRpcCredentialBackend — a CredentialBackend that delegates all credential
 * operations to the Credential Execution Service (CES) via stdio RPC.
 *
 * Maps RPC responses to the existing CredentialGetResult and DeleteResult
 * types. Errors are caught and mapped to unreachable/error states for
 * graceful fallback.
 */

import { CesRpcMethod } from "@vellumai/ces-contracts";

import type { CesClient } from "../credential-execution/client.js";
import { getLogger } from "../util/logger.js";
import type {
  CredentialBackend,
  CredentialGetResult,
  CredentialListResult,
  DeleteResult,
} from "./credential-backend.js";

const log = getLogger("ces-rpc-credential-backend");

export class CesRpcCredentialBackend implements CredentialBackend {
  readonly name = "ces-rpc";

  constructor(private readonly client: CesClient) {}

  isAvailable(): boolean {
    return this.client.isReady();
  }

  async get(account: string): Promise<CredentialGetResult> {
    if (!this.isAvailable()) {
      return { value: undefined, unreachable: true };
    }
    try {
      const result = await this.client.call(CesRpcMethod.GetCredential, {
        account,
      });
      return {
        value: result.found ? result.value : undefined,
        unreachable: false,
      };
    } catch (err) {
      log.warn({ err, account }, "CES RPC credential get failed");
      return { value: undefined, unreachable: true };
    }
  }

  async set(account: string, value: string): Promise<boolean> {
    if (!this.isAvailable()) return false;
    try {
      const result = await this.client.call(CesRpcMethod.SetCredential, {
        account,
        value,
      });
      return result.ok;
    } catch (err) {
      log.warn({ err, account }, "CES RPC credential set failed");
      return false;
    }
  }

  async delete(account: string): Promise<DeleteResult> {
    if (!this.isAvailable()) return "error";
    try {
      const result = await this.client.call(CesRpcMethod.DeleteCredential, {
        account,
      });
      return result.result;
    } catch (err) {
      log.warn({ err, account }, "CES RPC credential delete failed");
      return "error";
    }
  }

  async list(): Promise<CredentialListResult> {
    if (!this.isAvailable()) {
      return { accounts: [], unreachable: true };
    }
    try {
      const result = await this.client.call(CesRpcMethod.ListCredentials, {});
      return { accounts: result.accounts, unreachable: false };
    } catch (err) {
      log.warn({ err }, "CES RPC credential list failed");
      return { accounts: [], unreachable: true };
    }
  }
}
