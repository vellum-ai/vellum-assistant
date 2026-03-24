import { readFileSync } from "node:fs";

import type { SkillToolEntry, SkillToolManifest } from "../config/skills.js";

const VALID_RISK_LEVELS = new Set(["low", "medium", "high"]);
const VALID_EXECUTION_TARGETS = new Set(["host", "sandbox"]);

/**
 * Parse and validate a raw TOOLS.json payload into a typed SkillToolManifest.
 * Throws descriptive errors for any validation failure.
 */
export function parseToolManifest(raw: unknown): SkillToolManifest {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("TOOLS.json must be a JSON object");
  }

  const obj = raw as Record<string, unknown>;

  // Validate version
  if (!("version" in obj)) {
    throw new Error('TOOLS.json is missing required field "version"');
  }
  if (obj.version !== 1) {
    throw new Error(
      `TOOLS.json "version" must be 1, got: ${JSON.stringify(obj.version)}`,
    );
  }

  // Validate tools array
  if (!("tools" in obj)) {
    throw new Error('TOOLS.json is missing required field "tools"');
  }
  if (!Array.isArray(obj.tools)) {
    throw new Error('TOOLS.json "tools" must be an array');
  }
  if (obj.tools.length === 0) {
    throw new Error('TOOLS.json "tools" must contain at least one tool entry');
  }

  const tools: SkillToolEntry[] = [];
  const seenNames = new Set<string>();

  for (let i = 0; i < obj.tools.length; i++) {
    const entry = obj.tools[i];
    const prefix = `TOOLS.json tools[${i}]`;
    const tool = parseToolEntry(entry, prefix);

    if (seenNames.has(tool.name)) {
      throw new Error(`${prefix}: duplicate tool name "${tool.name}"`);
    }
    seenNames.add(tool.name);

    tools.push(tool);
  }

  return { version: 1, tools };
}

function parseToolEntry(raw: unknown, prefix: string): SkillToolEntry {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${prefix}: each tool entry must be a JSON object`);
  }

  const entry = raw as Record<string, unknown>;

  // name
  if (!("name" in entry) || typeof entry.name !== "string") {
    throw new Error(`${prefix}: missing or non-string "name"`);
  }
  const name = entry.name.trim();
  if (name.length === 0) {
    throw new Error(`${prefix}: "name" must be a non-empty string`);
  }

  // description
  if (!("description" in entry) || typeof entry.description !== "string") {
    throw new Error(`${prefix}: missing or non-string "description"`);
  }
  const description = entry.description.trim();
  if (description.length === 0) {
    throw new Error(`${prefix}: "description" must be a non-empty string`);
  }

  // category
  if (!("category" in entry) || typeof entry.category !== "string") {
    throw new Error(`${prefix}: missing or non-string "category"`);
  }
  const category = entry.category.trim();
  if (category.length === 0) {
    throw new Error(`${prefix}: "category" must be a non-empty string`);
  }

  // risk
  if (!("risk" in entry) || typeof entry.risk !== "string") {
    throw new Error(`${prefix}: missing or non-string "risk"`);
  }
  if (!VALID_RISK_LEVELS.has(entry.risk)) {
    throw new Error(
      `${prefix}: "risk" must be one of "low", "medium", "high", got: "${entry.risk}"`,
    );
  }
  const risk = entry.risk as SkillToolEntry["risk"];

  // input_schema
  if (
    !("input_schema" in entry) ||
    entry.input_schema == null ||
    typeof entry.input_schema !== "object" ||
    Array.isArray(entry.input_schema)
  ) {
    throw new Error(`${prefix}: missing or non-object "input_schema"`);
  }
  const input_schema = entry.input_schema as Record<string, unknown>;

  // executor
  if (!("executor" in entry) || typeof entry.executor !== "string") {
    throw new Error(`${prefix}: missing or non-string "executor"`);
  }
  const executor = entry.executor;
  if (executor.length === 0) {
    throw new Error(`${prefix}: "executor" must be a non-empty string`);
  }
  validateExecutorPath(executor, prefix);

  // execution_target
  if (
    !("execution_target" in entry) ||
    typeof entry.execution_target !== "string"
  ) {
    throw new Error(`${prefix}: missing or non-string "execution_target"`);
  }
  if (!VALID_EXECUTION_TARGETS.has(entry.execution_target)) {
    throw new Error(
      `${prefix}: "execution_target" must be one of "host", "sandbox", got: "${entry.execution_target}"`,
    );
  }
  const execution_target =
    entry.execution_target as SkillToolEntry["execution_target"];

  // trusted_auto_approve (optional boolean, defaults to false)
  let trusted_auto_approve: boolean | undefined;
  if ("trusted_auto_approve" in entry) {
    if (typeof entry.trusted_auto_approve !== "boolean") {
      throw new Error(
        `${prefix}: "trusted_auto_approve" must be a boolean if provided`,
      );
    }
    trusted_auto_approve = entry.trusted_auto_approve;
  }

  return {
    name,
    description,
    category,
    risk,
    input_schema,
    executor,
    execution_target,
    ...(trusted_auto_approve !== undefined ? { trusted_auto_approve } : {}),
  };
}

/**
 * Enforce that executor paths are relative and don't escape the skill directory.
 * Rejects absolute paths and paths containing `../`.
 */
function validateExecutorPath(executor: string, prefix: string): void {
  if (executor.startsWith("/")) {
    throw new Error(
      `${prefix}: "executor" must be a relative path, got absolute path: "${executor}"`,
    );
  }
  // Reject path traversal sequences
  const segments = executor.split("/");
  for (const segment of segments) {
    if (segment === "..") {
      throw new Error(
        `${prefix}: "executor" must not contain ".." path segments: "${executor}"`,
      );
    }
  }
}

/**
 * Read and parse a TOOLS.json file from disk.
 */
export function parseToolManifestFile(filePath: string): SkillToolManifest {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read TOOLS.json at "${filePath}": ${message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to parse TOOLS.json at "${filePath}" as JSON: ${message}`,
    );
  }

  return parseToolManifest(parsed);
}
