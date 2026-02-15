/**
 * TS-contract ↔ Swift-decoder drift checker.
 *
 * Compares server wire type literals from the IPC contract against
 * the decode `case "..."` entries in IPCMessages.swift's ServerMessage enum.
 * Reports any types present in one side but not the other.
 *
 * An allowlist covers contract types that the Swift client intentionally
 * does not decode (e.g. daemon-internal or CLI-only message types).
 *
 * Usage:
 *   bun run ipc:check-swift-drift    # check for drift
 */

import * as path from 'path';
import * as fs from 'fs';
import { extractInventory } from '../../src/daemon/ipc-contract-inventory.js';

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '../..');
const CONTRACT_PATH = path.join(ROOT, 'src/daemon/ipc-contract.ts');
const SWIFT_PATH = path.resolve(
  ROOT,
  '../clients/shared/IPC/IPCMessages.swift',
);

/**
 * Contract server wire types that the Swift client intentionally does NOT
 * decode. These are daemon-internal, CLI-only, or not relevant to the
 * macOS client. Add entries here with a comment explaining why.
 */
const SWIFT_OMIT_ALLOWLIST = new Set<string>([
  // Server-internal events not surfaced to macOS client
  'context_compacted',
  'memory_recalled',
  'model_info',
  'secret_detected',
  'sessions_clear_response',
  'usage_response',
  'usage_update',
]);

/**
 * Valid contract wire types that the inventory extractor cannot parse
 * because the contract type is a union alias (not a single interface).
 * These are still legitimate and decoded in Swift.
 */
const INVENTORY_UNEXTRACTABLE = new Set<string>([
  // UiSurfaceShow is a union of UiSurfaceShowCard | UiSurfaceShowForm | ...
  // The shared wire type 'ui_surface_show' comes from UiSurfaceShowBase.
  'ui_surface_show',
]);

// --- Extract Swift decode cases ---

/** Parse `case "wire_type":` patterns from the ServerMessage decoder. */
function extractSwiftDecodeCases(swiftSource: string): Set<string> {
  const cases = new Set<string>();
  // Match: case "some_wire_type":
  const re = /case\s+"([^"]+)":/g;
  let match: RegExpExecArray | null;

  // Only scan inside the ServerMessage init(from decoder:) block
  const decoderStart = swiftSource.indexOf('public init(from decoder: Decoder) throws');
  if (decoderStart === -1) {
    throw new Error('Could not find ServerMessage decoder in IPCMessages.swift');
  }

  const decoderSection = swiftSource.slice(decoderStart);

  while ((match = re.exec(decoderSection)) !== null) {
    cases.add(match[1]);
  }

  return cases;
}

// --- Main ---

const inventory = extractInventory(CONTRACT_PATH);
// Combine extractable wire types with known-unextractable ones
const contractServerTypes = new Set([
  ...inventory.serverWireTypes,
  ...INVENTORY_UNEXTRACTABLE,
]);

const swiftSource = fs.readFileSync(SWIFT_PATH, 'utf-8');
const swiftDecodeCases = extractSwiftDecodeCases(swiftSource);

const diffs: string[] = [];

// Types in contract but not decoded in Swift (and not in omit allowlist)
for (const wireType of contractServerTypes) {
  if (!swiftDecodeCases.has(wireType) && !SWIFT_OMIT_ALLOWLIST.has(wireType)) {
    diffs.push(`  + Contract has "${wireType}" but Swift does not decode it`);
  }
}

// Types decoded in Swift but not in contract
for (const wireType of swiftDecodeCases) {
  if (!contractServerTypes.has(wireType)) {
    diffs.push(`  - Swift decodes "${wireType}" but it is not in the contract`);
  }
}

// Stale allowlist entries
for (const wireType of SWIFT_OMIT_ALLOWLIST) {
  if (!contractServerTypes.has(wireType)) {
    diffs.push(`  ? Omit-allowlist entry "${wireType}" is not in the contract (stale?)`);
  }
}
for (const wireType of INVENTORY_UNEXTRACTABLE) {
  if (!swiftDecodeCases.has(wireType)) {
    diffs.push(`  ? Unextractable entry "${wireType}" is not decoded in Swift (stale?)`);
  }
}

if (diffs.length > 0) {
  console.error('IPC Swift decoder drift detected:\n');
  for (const line of diffs) {
    console.error(line);
  }
  console.error(
    '\nFix: update IPCMessages.swift decode cases, the contract, or the',
    'allowlist in check-swift-decoder-drift.ts.',
  );
  process.exit(1);
}

console.log('IPC Swift decoder is in sync with the contract.');
