/**
 * RPC handlers for CES credential metadata.
 */

import { CesRpcMethod } from "@vellumai/service-contracts/credential-rpc";

import type { RpcHandlerRegistry } from "../server.js";
import {
  getMetadataStore,
  type CesMetadataStore,
} from "./metadata-store.js";

export function buildRecordHandlers(): RpcHandlerRegistry {
  const handlers: RpcHandlerRegistry = {};

  handlers[CesRpcMethod.GetCredentialRecord] = (async (req: {
    account: string;
  }) => {
    const record = getMetadataStore().getByAccount(req.account);
    return { found: record !== undefined, record };
  }) as (typeof handlers)[string];

  handlers[CesRpcMethod.SetCredentialRecord] = (async (req: {
    account: string;
    record: Parameters<CesMetadataStore["setByAccount"]>[1];
  }) => {
    const ok = getMetadataStore().setByAccount(req.account, req.record);
    return { ok };
  }) as (typeof handlers)[string];

  handlers[CesRpcMethod.DeleteCredentialRecord] = (async (req: {
    account: string;
  }) => {
    const result = getMetadataStore().deleteByAccount(req.account);
    return { result };
  }) as (typeof handlers)[string];

  handlers[CesRpcMethod.ListCredentialRecords] = (async () => {
    return { records: getMetadataStore().list() };
  }) as (typeof handlers)[string];

  handlers[CesRpcMethod.BulkSetCredentialRecords] = (async (req: {
    records: Array<{
      account: string;
      record: Parameters<CesMetadataStore["setByAccount"]>[1];
    }>;
  }) => {
    const store = getMetadataStore();
    const results = [];
    for (const { account, record } of req.records) {
      const ok = store.setByAccount(account, record);
      results.push({ account, ok });
    }
    return { results };
  }) as (typeof handlers)[string];

  return handlers;
}
