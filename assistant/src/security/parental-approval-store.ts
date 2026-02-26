import { randomUUID } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

import { getRootDir } from '../util/platform.js'

export type ApprovalDecision = 'approve_always' | 'approve_once' | 'reject' | 'pending'

export interface ApprovalRequest {
  id: string
  toolName: string
  reason: string
  status: ApprovalDecision
  createdAt: string  // ISO 8601
  resolvedAt?: string
}

function getStorePath(): string {
  return join(getRootDir(), 'parental-approvals.json')
}

function readStore(): ApprovalRequest[] {
  try {
    const raw = readFileSync(getStorePath(), 'utf8')
    return JSON.parse(raw)
  } catch {
    return []
  }
}

function writeStore(entries: ApprovalRequest[]): void {
  mkdirSync(getRootDir(), { recursive: true })
  writeFileSync(getStorePath(), JSON.stringify(entries, null, 2), 'utf8')
}

export function createApprovalRequest(toolName: string, reason: string): ApprovalRequest {
  const entries = readStore()
  const entry: ApprovalRequest = {
    id: randomUUID(),
    toolName,
    reason,
    status: 'pending',
    createdAt: new Date().toISOString(),
  }
  entries.push(entry)
  writeStore(entries)
  return entry
}

export function listApprovalRequests(): ApprovalRequest[] {
  return readStore()
}

export function respondToApprovalRequest(
  requestId: string,
  decision: Exclude<ApprovalDecision, 'pending'>
): ApprovalRequest | null {
  const entries = readStore()
  const idx = entries.findIndex((e) => e.id === requestId)
  if (idx === -1) return null
  if (entries[idx].status !== 'pending') return null
  entries[idx] = { ...entries[idx], status: decision, resolvedAt: new Date().toISOString() }
  writeStore(entries)
  return entries[idx]
}

export function isToolApprovedAlways(toolName: string): boolean {
  const entries = readStore()
  return entries.some((e) => e.toolName === toolName && e.status === 'approve_always')
}

export function consumeApproveOnce(toolName: string): boolean {
  const entries = readStore()
  const idx = entries.findIndex((e) => e.toolName === toolName && e.status === 'approve_once')
  if (idx === -1) return false
  entries[idx] = { ...entries[idx], status: 'reject', resolvedAt: new Date().toISOString() }
  writeStore(entries)
  return true
}
