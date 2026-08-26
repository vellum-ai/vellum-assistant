/**
 * RPC handlers for CES credential records.
 */

import { CesRpcMethod } from "@vellumai/service-contracts/credential-rpc";
import type { RpcHandlerRegistry } from "../server.js";
import type { CesCredentialRecordStore } from "./credential-record-store.js";

export function buildRecordHandlers(
  recordStore: CesCredentialRecordStore,
): RpcHandlerRegistry {
  const handlers: RpcHandlerRegistry = {};

  handlers[CesRpcMethod.GetCredentialRecord] = (async (req: {
    account: string;
  }) => {
    const record = recordStore.getByAccount(req.account);
    return { found: record !== undefined, record };
  }) as (typeof handlers)[string];

  handlers[CesRpcMethod.SetCredentialRecord] = (async (req: {
    account: string;
    record: Parameters<CesCredentialRecordStore["setByAccount"]>[1];
  }) => {
    const ok = recordStore.setByAccount(req.account, req.record);
    return { ok };
  }) as (typeof handlers)[string];

  handlers[CesRpcMethod.DeleteCredentialRecord] = (async (req: {
    account: string;
  }) => {
    const result = recordStore.deleteByAccount(req.account);
    return { result };
  }) as (typeof handlers)[string];

  handlers[CesRpcMethod.ListCredentialRecords] = (async () => {
    return { records: recordStore.list() };
  }) as (typeof handlers)[string];

  handlers[CesRpcMethod.BulkSetCredentialRecords] = (async (req: {
    records: Array<{
      account: string;
      record: Parameters<CesCredentialRecordStore["setByAccount"]>[1];
    }>;
  }) => {
    const results = [];
    for (const { account, record } of req.records) {
      const ok = recordStore.setByAccount(account, record);
      results.push({ account, ok });
    }
    return { results };
  }) as (typeof handlers)[string];

  return handlers;
}
