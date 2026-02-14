/**
 * IPC Contract Inventory Checker
 *
 * Parses ipc-contract.ts with the TypeScript compiler API to extract
 * the string-literal discriminants of ClientMessage and ServerMessage,
 * then compares them against a checked-in snapshot.
 */

import * as ts from 'typescript';
import * as path from 'path';
import * as fs from 'fs';

const CONTRACT_PATH = path.resolve(
  import.meta.dirname ?? __dirname,
  'ipc-contract.ts',
);

const SNAPSHOT_PATH = path.resolve(
  import.meta.dirname ?? __dirname,
  '../__tests__/__snapshots__/ipc-contract-inventory.json',
);

export interface ContractInventory {
  clientMessageTypes: string[];
  serverMessageTypes: string[];
}

/**
 * Resolve the string literal `type` discriminant from each constituent
 * of a union type alias (e.g. ClientMessage = Foo | Bar | ...).
 */
function extractUnionDiscriminants(
  checker: ts.TypeChecker,
  unionType: ts.Type,
): string[] {
  const types = unionType.isUnion() ? unionType.types : [unionType];
  const discriminants: string[] = [];

  for (const memberType of types) {
    const typeProp = memberType.getProperty('type');
    if (!typeProp) continue;

    const propType = checker.getTypeOfSymbolAtLocation(
      typeProp,
      typeProp.valueDeclaration!,
    );

    if (propType.isStringLiteral()) {
      discriminants.push(propType.value);
    } else if (propType.isUnion()) {
      for (const t of propType.types) {
        if (t.isStringLiteral()) {
          discriminants.push(t.value);
        }
      }
    }
  }

  return [...new Set(discriminants)].sort();
}

export function extractInventory(): ContractInventory {
  const program = ts.createProgram([CONTRACT_PATH], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: true,
  });

  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(CONTRACT_PATH);
  if (!sourceFile) {
    throw new Error(`Could not load source file: ${CONTRACT_PATH}`);
  }

  let clientTypes: string[] = [];
  let serverTypes: string[] = [];

  ts.forEachChild(sourceFile, (node) => {
    if (ts.isTypeAliasDeclaration(node)) {
      const name = node.name.text;
      if (name === 'ClientMessage' || name === 'ServerMessage') {
        const aliasType = checker.getTypeAtLocation(node.name);
        const discriminants = extractUnionDiscriminants(checker, aliasType);
        if (name === 'ClientMessage') {
          clientTypes = discriminants;
        } else {
          serverTypes = discriminants;
        }
      }
    }
  });

  if (clientTypes.length === 0) {
    throw new Error('No ClientMessage type discriminants found');
  }
  if (serverTypes.length === 0) {
    throw new Error('No ServerMessage type discriminants found');
  }

  return {
    clientMessageTypes: clientTypes,
    serverMessageTypes: serverTypes,
  };
}

function loadSnapshot(): ContractInventory | null {
  try {
    const raw = fs.readFileSync(SNAPSHOT_PATH, 'utf-8');
    return JSON.parse(raw) as ContractInventory;
  } catch {
    return null;
  }
}

export function saveSnapshot(inventory: ContractInventory): void {
  fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
  fs.writeFileSync(
    SNAPSHOT_PATH,
    JSON.stringify(inventory, null, 2) + '\n',
    'utf-8',
  );
}

function diffArrays(
  label: string,
  expected: string[],
  actual: string[],
): string[] {
  const lines: string[] = [];
  const added = actual.filter((t) => !expected.includes(t));
  const removed = expected.filter((t) => !actual.includes(t));

  if (added.length > 0 || removed.length > 0) {
    lines.push(`  ${label}:`);
    for (const a of added) lines.push(`    + ${a}`);
    for (const r of removed) lines.push(`    - ${r}`);
  }
  return lines;
}

export function checkInventory(): { ok: boolean; diff: string } {
  const current = extractInventory();
  const snapshot = loadSnapshot();

  if (!snapshot) {
    return {
      ok: false,
      diff: 'No snapshot file found. Run with --update to create one.',
    };
  }

  const lines: string[] = [];
  lines.push(
    ...diffArrays(
      'ClientMessage',
      snapshot.clientMessageTypes,
      current.clientMessageTypes,
    ),
  );
  lines.push(
    ...diffArrays(
      'ServerMessage',
      snapshot.serverMessageTypes,
      current.serverMessageTypes,
    ),
  );

  if (lines.length === 0) {
    return { ok: true, diff: '' };
  }

  return {
    ok: false,
    diff: [
      'IPC contract inventory has drifted from snapshot:',
      ...lines,
      '',
      'Run `bun run ipc:inventory:update` to update the snapshot.',
    ].join('\n'),
  };
}
