/**
 * Core logic for extracting the IPC contract inventory from ipc-contract.ts.
 *
 * Parses the TypeScript AST to extract sorted union member lists for
 * ClientMessage and ServerMessage.
 */

import * as ts from 'typescript';
import * as path from 'path';
import * as fs from 'fs';

export interface ContractInventory {
  clientMessageTypes: string[];
  serverMessageTypes: string[];
}

/** Extract sorted union member names from a type alias declaration. */
function extractUnionMembers(
  sourceFile: ts.SourceFile,
  typeName: string,
): string[] {
  const members: string[] = [];

  ts.forEachChild(sourceFile, (node) => {
    if (
      ts.isTypeAliasDeclaration(node) &&
      node.name.text === typeName &&
      ts.isUnionTypeNode(node.type)
    ) {
      for (const member of node.type.types) {
        if (ts.isTypeReferenceNode(member)) {
          const name = member.typeName;
          if (ts.isIdentifier(name)) {
            members.push(name.text);
          }
        }
      }
    }
  });

  return members.sort();
}

/** Parse the contract file and extract the inventory. */
export function extractInventory(contractPath?: string): ContractInventory {
  const resolvedPath = contractPath ?? path.resolve(
    import.meta.dirname ?? __dirname,
    'ipc-contract.ts',
  );

  const source = fs.readFileSync(resolvedPath, 'utf-8');
  const sourceFile = ts.createSourceFile(
    path.basename(resolvedPath),
    source,
    ts.ScriptTarget.Latest,
    true,
  );

  const clientMessageTypes = extractUnionMembers(sourceFile, 'ClientMessage');
  const serverMessageTypes = extractUnionMembers(sourceFile, 'ServerMessage');

  if (clientMessageTypes.length === 0) {
    throw new Error('Failed to extract ClientMessage union members from contract');
  }
  if (serverMessageTypes.length === 0) {
    throw new Error('Failed to extract ServerMessage union members from contract');
  }

  return { clientMessageTypes, serverMessageTypes };
}
