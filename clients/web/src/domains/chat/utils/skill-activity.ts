/**
 * Pure projections that turn raw `skill_load` / `skill_execute` tool payloads
 * into the shapes the purpose-built activity detail UI renders (LUM-2999).
 *
 * Both skill tools are among the most frequently invoked in a turn, yet the
 * generic activity drawer renders them at their worst: `skill_load` dumps a
 * multi-thousand-line instruction body into a monospace `<pre>`, and
 * `skill_execute` shows its `{ tool, input, activity }` envelope as raw JSON so
 * the tool that actually ran is buried one level down. These parsers pull out
 * the parts a reader wants — which skill, what it provides, which inner tool
 * ran, with what parameters — so the components can render them directly.
 *
 * Intentionally pure: no React, no store access, no I/O. The daemon-side
 * producers are `assistant/src/tools/skills/load.ts` (whose `formatToolSchemas`
 * emits the "## Available Tools" section parsed here) and
 * `assistant/src/tools/skills/execute.ts` (whose `input_schema` defines the
 * envelope). Keep this module in sync with those two.
 */

/** A single parameter row under a skill tool's `Parameters:` list. */
export interface SkillToolParam {
  name: string;
  /** JSON-schema type as printed by the daemon (`string`, `object`, `any`, …). */
  type: string;
  required: boolean;
  /** Prose description; empty when the daemon printed the param bare. */
  description: string;
}

/** One tool advertised by a loaded skill's `TOOLS.json` manifest. */
export interface SkillToolSummary {
  name: string;
  description: string;
  params: SkillToolParam[];
  /**
   * Owning child skill when the tool came from a nested `### Tools from <x>`
   * block, else `null` for the parent skill's own tools. Lets the UI group
   * a composite skill's tools by origin.
   */
  fromSkill: string | null;
}

/** Readable projection of a `skill_load` call. */
export interface SkillLoadActivity {
  /** Skill id/name requested via `input.skill`. Empty when absent. */
  skillId: string;
  /**
   * Human-readable skill name from the result header's `Skill:` line
   * (the daemon's `skill.displayName`). Empty until the result lands.
   */
  displayName: string;
  /** One-line skill summary from the header's `Description:` line. */
  description: string;
  /**
   * The skill's instruction markdown, with the `Skill:`/`ID:`/`Description:`/
   * `Path:` header, the machine-facing "## Available Tools" section, and the
   * trailing include bookkeeping all removed — each is surfaced structurally
   * (or dropped) rather than rendered as prose.
   */
  instructions: string;
  /** Tools parsed out of the "## Available Tools" section, in document order. */
  tools: SkillToolSummary[];
  /** Failure text when the load errored, else `null`. */
  errorMessage: string | null;
}

/** One resolved parameter of the inner tool a `skill_execute` dispatched. */
export interface SkillExecuteParam {
  key: string;
  /**
   * Display string for a scalar value (string / number / boolean / null).
   * `null` when the value is an object or array — read `json` instead.
   */
  scalar: string | null;
  /** Pretty-printed JSON for object/array values; `null` for scalars. */
  json: string | null;
}

/** Readable projection of a `skill_execute` envelope. */
export interface SkillExecuteActivity {
  /** Inner tool from `input.tool` — the thing that actually ran. */
  innerToolName: string;
  /** Operator-facing sentence from `input.activity`. Empty when absent. */
  activity: string;
  /** Inner tool parameters, in insertion order. */
  params: SkillExecuteParam[];
}

/** Heading that opens the daemon's machine-facing tool manifest section. */
const AVAILABLE_TOOLS_HEADING = /^##\s+Available Tools\s*$/;

/** `### Tools from <child skill>` sub-heading emitted for nested manifests. */
const CHILD_SKILL_HEADING = /^###\s+Tools from\s+(.+?)\s*$/;

/** A tool heading: `### name` (parent skill) or `#### name` (child skill). */
const TOOL_HEADING = /^#{3,4}\s+(\S+)\s*$/;

/** `- name (type, required): description` — description optional. */
const PARAM_LINE =
  /^[-*]\s+(\S+?)\s*\(([^,()]+),\s*(required|optional)\)\s*(?::\s*(.*))?$/;

/** Boilerplate the daemon prints under the heading; carries no reader value. */
const TOOLS_PREAMBLE = /^Use `skill_execute` to call these tools\.\s*$/;

/** Literal `Parameters:` line that opens a tool's parameter list. */
const PARAMS_LABEL = /^Parameters:\s*$/;

/**
 * Lines that mark the end of the human-relevant part of a `skill_load` body.
 *
 * After the tool manifest the daemon appends pure bookkeeping — the immediate
 * include listing, the not-installed suggestions, and `<loaded_skill … />`
 * projection markers (`assistant/src/tools/skills/load.ts:617-620`). None of it
 * is for a reader, and because the manifest parser treats any non-heading line
 * after a tool as description, leaving it in would glue all of it onto the last
 * tool's description card.
 *
 * Note this deliberately does NOT terminate on `### Tools from …`: those child
 * manifests (`includedBodies`) sit between the parent manifest and this trailer
 * and are legitimate tool content the parser attributes via `fromSkill`.
 */
const MANIFEST_TERMINATORS = [
  /^Included Skills \(immediate\):/,
  /^Suggested Included Skills \(not loaded\):/,
  /^<loaded_skill\b/,
];

/** `Skill:` / `ID:` / `Description:` / `Path:` header line at the body's head. */
const HEADER_LINE = /^(Skill|ID|Description|Path):\s*(.*)$/;

/** Read a trimmed string property from an input bag, else `""`. */
function readString(bag: Record<string, unknown>, key: string): string {
  const value = bag[key];
  return typeof value === "string" ? value.trim() : "";
}

/** Coerce unknown tool input into a plain bag, tolerating null/non-objects. */
function toBag(input: unknown): Record<string, unknown> {
  return input != null && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

/**
 * Split a `skill_load` result body at the "## Available Tools" heading.
 *
 * Everything before the heading is the human-readable instruction markdown;
 * everything from the heading onward is the structured manifest. A body with
 * no such heading is entirely instructions.
 */
function splitAtToolsSection(body: string): {
  instructions: string;
  toolsSection: string;
} {
  const lines = body.split("\n");
  const headingIndex = lines.findIndex((line) =>
    AVAILABLE_TOOLS_HEADING.test(line),
  );
  if (headingIndex === -1) {
    return { instructions: body.trimEnd(), toolsSection: "" };
  }
  return {
    instructions: lines.slice(0, headingIndex).join("\n").trimEnd(),
    toolsSection: lines.slice(headingIndex + 1).join("\n"),
  };
}

/**
 * Drop the machine-only trailer the daemon appends after the manifest. Cuts at
 * the first {@link MANIFEST_TERMINATORS} match; a body without one is returned
 * unchanged. Applied before any other split so the trailer can't leak into the
 * tool descriptions OR — for a manifest-less skill, which has no
 * "## Available Tools" heading to split on — into the rendered instructions.
 */
function stripMachineTrailer(body: string): string {
  const lines = body.split("\n");
  const cut = lines.findIndex((line) =>
    MANIFEST_TERMINATORS.some((pattern) => pattern.test(line)),
  );
  return cut === -1 ? body : lines.slice(0, cut).join("\n").trimEnd();
}

/**
 * Pull the `Skill:` / `ID:` / `Description:` / `Path:` header off the front of
 * a load body, returning the parsed fields and the remaining instructions.
 *
 * The daemon emits these four lines ahead of the skill body
 * (`assistant/src/tools/skills/load.ts:598-601`). They're the source of the
 * human-readable name, but rendered as markdown they read as four stray
 * key-value lines above the real content — so they're lifted out here and shown
 * structurally instead.
 */
function splitHeader(body: string): {
  displayName: string;
  description: string;
  rest: string;
} {
  const lines = body.split("\n");
  const fields: Record<string, string> = {};
  let index = 0;
  while (index < lines.length) {
    const match = HEADER_LINE.exec(lines[index]!);
    if (!match) {
      break;
    }
    fields[match[1]!] = match[2]!.trim();
    index++;
  }
  // Nothing recognised — leave the body untouched rather than eating a line
  // that merely happened to start with a colon-suffixed word.
  if (index === 0) {
    return { displayName: "", description: "", rest: body };
  }
  return {
    displayName: fields.Skill ?? "",
    description: fields.Description ?? "",
    rest: lines.slice(index).join("\n").replace(/^\n+/, ""),
  };
}

/**
 * Parse the daemon's "## Available Tools" block into structured tool
 * summaries. Mirrors the emitter in `formatToolSchemas`
 * (`assistant/src/tools/skills/load.ts`): a `### <name>` heading per tool,
 * free-text description lines, then an optional `Parameters:` list. Nested
 * manifests introduce their tools under `### Tools from <skill>` with
 * `#### <name>` headings, which we attribute via `fromSkill`.
 *
 * Unrecognised lines are treated as description text rather than dropped, so a
 * daemon-side format tweak degrades to slightly noisy prose instead of an
 * empty tool list.
 */
function parseToolsSection(section: string): SkillToolSummary[] {
  if (!section.trim()) {
    return [];
  }

  const tools: SkillToolSummary[] = [];
  let current: SkillToolSummary | null = null;
  let currentSkill: string | null = null;
  let inParams = false;
  let descriptionLines: string[] = [];

  const flush = () => {
    if (current) {
      current.description = descriptionLines.join("\n").trim();
      tools.push(current);
    }
    current = null;
    descriptionLines = [];
    inParams = false;
  };

  for (const line of section.split("\n")) {
    const childMatch = CHILD_SKILL_HEADING.exec(line);
    if (childMatch) {
      flush();
      currentSkill = childMatch[1]!;
      continue;
    }

    const toolMatch = TOOL_HEADING.exec(line);
    if (toolMatch) {
      flush();
      current = {
        name: toolMatch[1]!,
        description: "",
        params: [],
        fromSkill: currentSkill,
      };
      continue;
    }

    if (!current) {
      // Preamble between the heading and the first tool.
      continue;
    }

    if (PARAMS_LABEL.test(line)) {
      inParams = true;
      continue;
    }

    if (inParams) {
      const paramMatch = PARAM_LINE.exec(line);
      if (paramMatch) {
        current.params.push({
          name: paramMatch[1]!,
          type: paramMatch[2]!.trim(),
          required: paramMatch[3] === "required",
          description: (paramMatch[4] ?? "").trim(),
        });
        continue;
      }
      // A non-param line ends the list; fall through so it joins the prose.
      inParams = false;
    }

    if (TOOLS_PREAMBLE.test(line)) {
      continue;
    }
    descriptionLines.push(line);
  }

  flush();
  return tools;
}

/**
 * True when a `skill_load` result body reads as a failure. The daemon returns
 * `{ content: "Error: …", isError: true }` for bad input and surfaces
 * feature-gated skills as prose, so we treat the explicit `isError` flag as
 * authoritative and fall back to the `Error:` prefix the tool itself emits.
 */
function isErrorBody(body: string, isError: boolean): boolean {
  return isError || /^Error:/.test(body.trimStart());
}

/**
 * Project a `skill_load` call into its readable parts.
 *
 * `result` is the tool's returned instruction body (absent while the call is
 * still running, in which case the projection carries only the skill id).
 */
export function parseSkillLoadActivity({
  input,
  result,
  isError = false,
}: {
  input: unknown;
  result?: unknown;
  isError?: boolean;
}): SkillLoadActivity {
  const bag = toBag(input);
  const skillId = readString(bag, "skill");
  const body = typeof result === "string" ? result : "";

  if (!body) {
    return {
      skillId,
      displayName: "",
      description: "",
      instructions: "",
      tools: [],
      errorMessage: null,
    };
  }

  if (isErrorBody(body, isError)) {
    return {
      skillId,
      displayName: "",
      description: "",
      instructions: "",
      tools: [],
      errorMessage: body.trim(),
    };
  }

  const { displayName, description, rest } = splitHeader(
    stripMachineTrailer(body),
  );
  const { instructions, toolsSection } = splitAtToolsSection(rest);
  return {
    skillId,
    displayName,
    description,
    instructions,
    tools: parseToolsSection(toolsSection),
    errorMessage: null,
  };
}

/**
 * Format a single inner-tool parameter value for display. Scalars render
 * inline; objects and arrays are pretty-printed as JSON so nested structure
 * stays legible. A value that can't be serialised (a cycle) degrades to its
 * `String()` form rather than throwing.
 */
function formatParamValue(
  value: unknown,
): Pick<SkillExecuteParam, "scalar" | "json"> {
  if (value === null) {
    return { scalar: "null", json: null };
  }
  if (typeof value === "string") {
    return { scalar: value, json: null };
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return { scalar: String(value), json: null };
  }
  if (typeof value === "undefined") {
    return { scalar: "undefined", json: null };
  }
  try {
    return {
      scalar: null,
      json: JSON.stringify(value, null, 2) ?? String(value),
    };
  } catch {
    return { scalar: String(value), json: null };
  }
}

/**
 * Project a `skill_execute` envelope into its readable parts.
 *
 * The documented envelope is `{ tool, input: {...}, activity }`. Weaker models
 * routinely misplace the inner parameters — the daemon's
 * `resolveSkillExecuteParams` rescues several of those shapes before dispatch,
 * and we mirror the two that reach the client: `input` arriving as a
 * JSON-encoded string, and parameters spread as top-level siblings of
 * `tool`/`activity`. Matching that leniency keeps the drawer readable for
 * exactly the calls that most need explaining.
 */
export function parseSkillExecuteActivity(input: unknown): SkillExecuteActivity {
  const bag = toBag(input);
  const innerToolName = readString(bag, "tool");
  const activity = readString(bag, "activity");

  let inner = bag.input;

  // `input` passed as a JSON-encoded string.
  if (typeof inner === "string") {
    const raw = inner;
    try {
      inner = JSON.parse(raw) as unknown;
    } catch {
      // Not JSON — surface the raw string under its own key so it's not lost.
      return {
        innerToolName,
        activity,
        params: [{ key: "input", scalar: raw, json: null }],
      };
    }
  }

  let innerBag = toBag(inner);

  // Parameters spread as siblings of the envelope keys.
  if (Object.keys(innerBag).length === 0) {
    const siblings = Object.fromEntries(
      Object.entries(bag).filter(
        ([key]) => key !== "tool" && key !== "input" && key !== "activity",
      ),
    );
    if (Object.keys(siblings).length > 0) {
      innerBag = siblings;
    }
  }

  const params: SkillExecuteParam[] = Object.entries(innerBag).map(
    ([key, value]) => ({ key, ...formatParamValue(value) }),
  );

  return { innerToolName, activity, params };
}

/** Tool names this module renders purpose-built UI for. */
export const SKILL_ACTIVITY_TOOL_NAMES = new Set([
  "skill_load",
  "skill_execute",
]);
