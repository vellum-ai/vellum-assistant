/**
 * Core logic for extracting the IPC contract inventory from ipc-protocol.ts.
 *
 * Parses the TypeScript AST to extract sorted union member lists for
 * ClientMessage and ServerMessage. Interface declarations are resolved
 * from both the protocol file and the domain files in ipc-contract/.
 */

import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

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
  sourceFiles: ts.SourceFile[],
  interfaceName: string,
): string | null {
  for (const sourceFile of sourceFiles) {
    let wireType: string | null = null;

    ts.forEachChild(sourceFile, (node) => {
      if (ts.isInterfaceDeclaration(node) && node.name.text === interfaceName) {
        for (const member of node.members) {
          if (
            ts.isPropertySignature(member) &&
            member.name &&
            ts.isIdentifier(member.name) &&
            member.name.text === "type" &&
            member.type &&
            ts.isLiteralTypeNode(member.type) &&
            ts.isStringLiteral(member.type.literal)
          ) {
            wireType = member.type.literal.text;
          }
        }
      }
    });

    if (wireType) return wireType;
  }

  return null;
}

/**
 * Resolve a type alias to its union member names. If the name is a type
 * alias whose body is a union of type references, returns those reference
 * names. Otherwise returns the name itself (it's likely an interface).
 */
function resolveTypeAlias(
  sourceFiles: ts.SourceFile[],
  aliasName: string,
): string[] {
  for (const sourceFile of sourceFiles) {
    let resolved: string[] | null = null;
    ts.forEachChild(sourceFile, (node) => {
      if (ts.isTypeAliasDeclaration(node) && node.name.text === aliasName) {
        if (ts.isUnionTypeNode(node.type)) {
          resolved = [];
          for (const member of node.type.types) {
            if (ts.isTypeReferenceNode(member)) {
              const name = member.typeName;
              if (ts.isIdentifier(name)) {
                resolved.push(name.text);
              }
            }
          }
        } else if (ts.isTypeReferenceNode(node.type)) {
          // Single type alias (e.g. `type _X = SomeInterface`)
          const name = node.type.typeName;
          if (ts.isIdentifier(name)) {
            resolved = [name.text];
          }
        }
      }
    });
    if (resolved) return resolved;
  }
  // Not a type alias -- treat as a direct interface name
  return [aliasName];
}

/**
 * Extract wire type literals for all members of a union type.
 * Handles both direct interface references and type alias unions
 * (domain-level aliases like _SessionsClientMessages).
 */
function extractWireTypes(
  sourceFiles: ts.SourceFile[],
  memberNames: string[],
): string[] {
  const wireTypes: string[] = [];
  for (const name of memberNames) {
    // Resolve type aliases to their constituent interface names
    const resolved = resolveTypeAlias(sourceFiles, name);
    for (const interfaceName of resolved) {
      const wt = extractWireType(sourceFiles, interfaceName);
      if (wt) wireTypes.push(wt);
    }
  }
  return wireTypes.sort();
}

/**
 * Parse all .ts files in the domain directory (ipc-contract/) and return
 * their parsed ASTs alongside the barrel file's AST.
 */
function parseDomainFiles(barrelDir: string): ts.SourceFile[] {
  const domainDir = path.join(barrelDir, "ipc-contract");
  if (!fs.existsSync(domainDir)) return [];

  return fs
    .readdirSync(domainDir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => {
      const filePath = path.join(domainDir, f);
      const source = fs.readFileSync(filePath, "utf-8");
      return ts.createSourceFile(f, source, ts.ScriptTarget.Latest, true);
    });
}

/** Parse the contract file and extract the inventory. */
export function extractInventory(contractPath?: string): ContractInventory {
  const resolvedPath =
    contractPath ??
    path.resolve(import.meta.dirname ?? __dirname, "ipc-protocol.ts");

  const source = fs.readFileSync(resolvedPath, "utf-8");
  const barrelFile = ts.createSourceFile(
    path.basename(resolvedPath),
    source,
    ts.ScriptTarget.Latest,
    true,
  );

  const clientMessageTypes = extractUnionMembers(barrelFile, "ClientMessage");
  const serverMessageTypes = extractUnionMembers(barrelFile, "ServerMessage");

  if (clientMessageTypes.length === 0) {
    throw new Error(
      "Failed to extract ClientMessage union members from contract",
    );
  }
  if (serverMessageTypes.length === 0) {
    throw new Error(
      "Failed to extract ServerMessage union members from contract",
    );
  }

  // Parse domain files for interface declarations (wire type extraction)
  const domainFiles = parseDomainFiles(path.dirname(resolvedPath));
  const allSourceFiles = [barrelFile, ...domainFiles];

  const clientWireTypes = extractWireTypes(allSourceFiles, clientMessageTypes);
  const serverWireTypes = extractWireTypes(allSourceFiles, serverMessageTypes);

  return {
    clientMessageTypes,
    serverMessageTypes,
    clientWireTypes,
    serverWireTypes,
  };
}
