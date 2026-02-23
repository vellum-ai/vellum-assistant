/**
 * IPC contract → Swift code generator.
 *
 * Pipeline:
 *   1. typescript-json-schema extracts JSON Schema from ipc-contract.ts
 *   2. Schemas are walked to produce Swift Codable structs and enums
 *   3. Output is written to clients/shared/IPC/Generated/IPCContractGenerated.swift
 *
 * The generated structs are standalone DTOs. The discriminated union enums
 * (ClientMessage/ServerMessage) stay in the hand-written IPCMessages.swift
 * since they require custom Decodable init logic.
 *
 * Usage:
 *   bun run generate:ipc              # generate the file
 *   bun run generate:ipc -- --check   # fail if output would differ (CI)
 */

import * as path from 'path';
import * as fs from 'fs';
import * as TJS from 'typescript-json-schema';

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '../..');
const CONTRACT_PATH = path.join(ROOT, 'src/daemon/ipc-contract.ts');
const OUTPUT_PATH = path.resolve(
  ROOT,
  '../clients/shared/IPC/Generated/IPCContractGenerated.swift',
);

const PREAMBLE = `// AUTO-GENERATED from assistant/src/daemon/ipc-contract.ts — DO NOT EDIT
// Regenerate: cd assistant && bun run generate:ipc
//
// This file contains Swift Codable DTOs derived from the IPC contract.
// The discriminated union enums (ClientMessage/ServerMessage) remain
// in the hand-written IPCMessages.swift since they require custom
// Decodable init logic that code generators cannot express cleanly.

import Foundation
`;

// --- Config ---

/** Types to skip entirely. */
const SKIP_TYPES = new Set([
  'ClientMessage',
  'ServerMessage',
  'IPCContractSchema',
  'SurfaceData',
  'SurfaceType',
  'UiSurfaceShow',
  'UiSurfaceShowBase',
  'INTERACTIVE_SURFACE_TYPES',
  // String-union types that need hand-written Swift enums
  'SessionErrorCode',
  'TraceEventKind',
  // Uses SessionErrorCode and TraceEventKind which are hand-maintained enums
  'SessionErrorMessage',
  'TraceEvent',
]);

// --- JSON Schema type definitions ---

interface SchemaDef {
  type?: string;
  properties?: Record<string, SchemaDef>;
  required?: string[];
  enum?: string[];
  const?: string;
  $ref?: string;
  items?: SchemaDef;
  anyOf?: SchemaDef[];
  additionalProperties?: boolean | SchemaDef;
  description?: string;
  definitions?: Record<string, SchemaDef>;
}

// --- Step 1: Generate JSON Schema from TypeScript ---

function generateSchemas(): Record<string, SchemaDef> {
  const program = TJS.getProgramFromFiles([CONTRACT_PATH], {
    strict: true,
    target: 99,
    module: 199,
    moduleResolution: 99,
    skipLibCheck: true,
  });

  const generator = TJS.buildGenerator(program, {
    required: true,
    noExtraProps: false,
    strictNullChecks: true,
    ref: true,
  });

  if (!generator) {
    throw new Error('Failed to create schema generator');
  }

  const symbols = generator.getMainFileSymbols(program, [CONTRACT_PATH]);
  const result: Record<string, SchemaDef> = {};

  const skipped: string[] = [];

  for (const symbol of symbols) {
    if (SKIP_TYPES.has(symbol)) continue;
    try {
      const schema = generator.getSchemaForSymbol(symbol) as SchemaDef | null;
      if (schema) {
        result[symbol] = schema;
      } else {
        skipped.push(symbol);
      }
    } catch {
      skipped.push(symbol);
    }
  }

  if (skipped.length > 0) {
    console.warn(`Warning: skipped ${skipped.length} symbol(s) that could not produce schemas:`);
    for (const s of skipped) {
      console.warn(`  - ${s}`);
    }
  }

  // Extract nested definitions from schemas (e.g. imported types referenced via $ref)
  for (const schema of Object.values(result)) {
    if (!schema.definitions) continue;
    for (const [defName, defSchema] of Object.entries(schema.definitions)) {
      // Skip generic type references (e.g. Partial<CardSurfaceData>, Record<string,unknown>)
      // — these produce invalid Swift struct names and are already handled as
      // [String: AnyCodable] in schemaToSwiftType via the startsWith checks.
      if (!result[defName] && !SKIP_TYPES.has(defName) && !defName.includes('<')) {
        result[defName] = defSchema;
      }
    }
  }

  return result;
}

// --- Step 2: Convert JSON Schema to Swift model ---

/** Resolve "#/definitions/Foo" → "Foo". */
function resolveRef(ref: string): string {
  const match = ref.match(/^#\/definitions\/(.+)$/);
  return match ? decodeURIComponent(match[1]) : ref;
}

/**
 * Heuristic: properties whose names match these patterns should be Int, not Double.
 * JSON Schema uses "number" for both, but the TS contract uses `number` for both
 * int-like values (counts, sizes) and float-like values (cost, timestamps).
 */
const INT_PATTERNS = [
  /[Tt]okens?$/,
  /[Cc]ount$/,
  /[Nn]umber$/,
  /[Ss]tep\w*$/,
  /[Pp]osition$/,
  /[Pp]riority$/,
  /[Ww]idth$/,
  /[Hh]eight$/,
  /[Ss]ize\w*$/,
  /^format_version$/,
  /At$/,
  /[Ss]tars$/,
  /[Ii]nstalls$/,
  /[Dd]ownloads$/,
  /[Vv]ersions$/,
  /[Rr]eports$/,
  /maxFiles$/,
  /maxSizeBytes$/,
  /removedCount$/,
  /cleared$/,
  /queuedCount$/,
  /^maxResponseTokens$/,
  /Messages$/,
  /Calls$/,
  /^sequence$/,
  /[Ll]ength$/,
  /[Ii]ndex$/,
  /[Ee]xpected$/,
  /[Uu]ndos$/,
  /Ms$/,
];

function shouldBeInt(propName: string): boolean {
  return INT_PATTERNS.some((p) => p.test(propName));
}

interface SwiftProperty {
  swiftName: string;
  jsonName: string;
  swiftType: string;
  isOptional: boolean;
  doc?: string;
}

interface SwiftStruct {
  name: string;
  properties: SwiftProperty[];
  doc?: string;
}

// Collector for extracted inline structs
const extractedStructs: SwiftStruct[] = [];

/**
 * Convert a schema property to its Swift type string.
 * When encountering inline objects, extracts them as separate named structs.
 */
function schemaToSwiftType(
  prop: SchemaDef,
  parentName: string,
  propName: string,
  allDefs: Record<string, SchemaDef>,
): string {
  // $ref → named type
  if (prop.$ref) {
    const refName = resolveRef(prop.$ref);

    if (refName === 'Record<string,unknown>') return '[String: AnyCodable]';
    if (refName === 'Record<string,string>') return '[String: String]';
    if (refName.startsWith('Record<')) return '[String: AnyCodable]';
    if (refName.startsWith('Partial<')) return '[String: AnyCodable]';

    // String enum types (e.g. SessionErrorCode, TraceEventKind) don't produce
    // generated structs — emit as plain String so the output compiles.
    const refDef = allDefs[refName];
    if (refDef && refDef.type === 'string' && refDef.enum) {
      return 'String';
    }

    return `IPC${refName}`;
  }

  // Array type syntax: e.g. "type": ["null", "string"] → String?
  if (Array.isArray(prop.type)) {
    const nonNull = prop.type.filter((t: string) => t !== 'null');
    const hasNull = prop.type.includes('null');
    if (nonNull.length === 1) {
      const inner = schemaToSwiftType({ type: nonNull[0] }, parentName, propName, allDefs);
      return hasNull ? `${inner}?` : inner;
    }
    return 'AnyCodable';
  }

  // anyOf — union. Check nullable pattern: [T, {type: "null"}]
  if (prop.anyOf) {
    const nonNull = prop.anyOf.filter((v) => v.type !== 'null');
    const hasNull = prop.anyOf.some((v) => v.type === 'null');

    if (nonNull.length === 1) {
      const inner = schemaToSwiftType(nonNull[0], parentName, propName, allDefs);
      return hasNull ? `${inner}?` : inner;
    }

    // Multi-type union
    return 'AnyCodable';
  }

  // Primitives
  switch (prop.type) {
    case 'string':
      return 'String';
    case 'number':
      return shouldBeInt(propName) ? 'Int' : 'Double';
    case 'integer':
      return 'Int';
    case 'boolean':
      return 'Bool';

    case 'object':
      // Inline object with named properties → extract as a struct
      if (prop.properties) {
        const structName = `${parentName}${capitalize(propName)}`;
        extractInlineStruct(structName, prop, allDefs);
        return structName;
      }
      // Map type
      if (prop.additionalProperties && typeof prop.additionalProperties === 'object') {
        const valueType = schemaToSwiftType(prop.additionalProperties, parentName, propName, allDefs);
        return `[String: ${valueType}]`;
      }
      return '[String: AnyCodable]';

    case 'array':
      if (prop.items) {
        const itemType = schemaToSwiftType(prop.items, parentName, singularize(propName), allDefs);
        return `[${itemType}]`;
      }
      return '[AnyCodable]';

    case 'null':
      return 'AnyCodable?';
  }

  return 'AnyCodable';
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function singularize(s: string): string {
  // Crude singularization for array item names
  if (s.endsWith('ies')) return s.slice(0, -3) + 'y';
  if (s.endsWith('ches') || s.endsWith('shes') || s.endsWith('ses') || s.endsWith('xes') || s.endsWith('zes')) return s.slice(0, -2);
  if (s.endsWith('s') && !s.endsWith('ss')) return s.slice(0, -1);
  return s;
}

/**
 * Extract an inline object as a separate named struct.
 */
function extractInlineStruct(
  name: string,
  schema: SchemaDef,
  allDefs: Record<string, SchemaDef>,
): void {
  // Prevent duplicates
  if (extractedStructs.some((s) => s.name === name)) return;

  const required = new Set(schema.required ?? []);
  const properties: SwiftProperty[] = [];

  for (const [pName, pDef] of Object.entries(schema.properties ?? {})) {
    let swiftType = schemaToSwiftType(pDef, name, pName, allDefs);

    const isOptional = !required.has(pName);
    if (isOptional && !swiftType.endsWith('?')) {
      swiftType = `${swiftType}?`;
    }

    properties.push({
      swiftName: pName,
      jsonName: pName,
      swiftType,
      isOptional,
      doc: pDef.description,
    });
  }

  extractedStructs.push({ name, properties });
}

// --- Step 3: Build all structs ---

function buildAllStructs(
  allDefs: Record<string, SchemaDef>,
): SwiftStruct[] {
  const structs: SwiftStruct[] = [];

  for (const [name, def] of Object.entries(allDefs).sort(([a], [b]) => a.localeCompare(b))) {
    if (def.type !== 'object' || !def.properties) continue;

    const ipcName = `IPC${name}`;
    const required = new Set(def.required ?? []);
    const properties: SwiftProperty[] = [];

    for (const [propName, propDef] of Object.entries(def.properties)) {
      let swiftType = schemaToSwiftType(propDef, ipcName, propName, allDefs);

      const isOptional = !required.has(propName);
      if (isOptional && !swiftType.endsWith('?')) {
        swiftType = `${swiftType}?`;
      }

      properties.push({
        swiftName: propName,
        jsonName: propName,
        swiftType,
        isOptional,
        doc: propDef.description,
      });
    }

    structs.push({
      name: ipcName,
      properties,
      doc: def.description,
    });
  }

  return structs;
}

// --- Step 4: Emit Swift code ---

function needsCodingKeys(props: SwiftProperty[]): boolean {
  return props.some((p) => p.jsonName !== p.swiftName);
}

function emitStruct(s: SwiftStruct): string {
  const lines: string[] = [];

  if (s.doc) {
    lines.push(`/// ${s.doc}`);
  }

  lines.push(`public struct ${s.name}: Codable, Sendable {`);

  for (const p of s.properties) {
    if (p.doc) {
      lines.push(`    /// ${p.doc}`);
    }
    lines.push(`    public let ${p.swiftName}: ${p.swiftType}`);
  }

  if (needsCodingKeys(s.properties)) {
    lines.push('');
    lines.push('    private enum CodingKeys: String, CodingKey {');
    for (const p of s.properties) {
      if (p.jsonName !== p.swiftName) {
        lines.push(`        case ${p.swiftName} = "${p.jsonName}"`);
      } else {
        lines.push(`        case ${p.swiftName}`);
      }
    }
    lines.push('    }');
  }

  lines.push('}');
  return lines.join('\n');
}

// --- Main ---

async function main(): Promise<void> {
  const isCheck = process.argv.includes('--check');

  console.log('Generating JSON Schema from ipc-contract.ts...');
  const allDefs = generateSchemas();
  console.log(`Found ${Object.keys(allDefs).length} type definitions`);

  // Reset extracted inline structs
  extractedStructs.length = 0;

  // Build top-level structs (this also populates extractedStructs for inline objects)
  const topLevelStructs = buildAllStructs(allDefs);

  // Merge: top-level first, then extracted inline structs (deduped)
  const allStructNames = new Set(topLevelStructs.map((s) => s.name));
  const inlineOnly = extractedStructs.filter((s) => !allStructNames.has(s.name));
  const allStructs = [...topLevelStructs, ...inlineOnly].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  console.log(
    `Generated ${topLevelStructs.length} top-level structs, ${inlineOnly.length} inline structs`,
  );

  const sections: string[] = [PREAMBLE];

  sections.push('// MARK: - Generated IPC types\n');
  for (const s of allStructs) {
    sections.push(emitStruct(s));
    sections.push('');
  }

  const output = sections.join('\n');

  // Ensure output directory exists
  const outputDir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  if (isCheck) {
    if (!fs.existsSync(OUTPUT_PATH)) {
      console.error(`Generated file not found at ${OUTPUT_PATH}`);
      console.error('Run `bun run generate:ipc` to create it.');
      process.exit(1);
    }

    const existing = fs.readFileSync(OUTPUT_PATH, 'utf-8');
    if (existing !== output) {
      console.error('Generated Swift file is out of date.');
      console.error('Run `bun run generate:ipc` to regenerate.');
      process.exit(1);
    }

    console.log('Generated Swift file is up to date.');
    return;
  }

  fs.writeFileSync(OUTPUT_PATH, output, 'utf-8');
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
