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
  /** Wire type string literals (e.g. "user_message") from ClientMessage interfaces. */
  clientWireTypes: string[];
  /** Wire type string literals (e.g. "assistant_text_delta") from ServerMessage interfaces. */
  serverWireTypes: string[];
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

/**
 * Extract the `type` string literal from an interface declaration.
 * Looks for `type: 'some_wire_type'` property signatures.
 */
function extractWireType(
  sourceFile: ts.SourceFile,
  interfaceName: string,
): string | null {
  let wireType: string | null = null;

  ts.forEachChild(sourceFile, (node) => {
    if (
      ts.isInterfaceDeclaration(node) &&
      node.name.text === interfaceName
    ) {
      for (const member of node.members) {
        if (
          ts.isPropertySignature(member) &&
          member.name &&
          ts.isIdentifier(member.name) &&
          member.name.text === 'type' &&
          member.type &&
          ts.isLiteralTypeNode(member.type) &&
          ts.isStringLiteral(member.type.literal)
        ) {
          wireType = member.type.literal.text;
        }
      }
    }
  });

  return wireType;
}

/**
 * Extract wire type literals for all members of a union type.
 */
function extractWireTypes(
  sourceFile: ts.SourceFile,
  memberNames: string[],
): string[] {
  const wireTypes: string[] = [];
  for (const name of memberNames) {
    const wt = extractWireType(sourceFile, name);
    if (wt) wireTypes.push(wt);
  }
  return wireTypes.sort();
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

  const clientWireTypes = extractWireTypes(sourceFile, clientMessageTypes);
  const serverWireTypes = extractWireTypes(sourceFile, serverMessageTypes);

  return { clientMessageTypes, serverMessageTypes, clientWireTypes, serverWireTypes };
}
