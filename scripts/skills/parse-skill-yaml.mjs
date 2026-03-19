/**
 * Shared minimal YAML parser for SKILL.md frontmatter.
 *
 * Used by both `generate-catalog.mjs` and `lint-skill-spec.mjs` to ensure
 * consistent parsing of skill frontmatter across tooling.
 */

/**
 * Parse YAML frontmatter from a SKILL.md content string.
 * Returns { frontmatter: Record<string, unknown>, body: string }.
 */
export function parseFrontmatter(content) {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) {
    throw new Error("SKILL.md must start with YAML frontmatter (---).");
  }

  const endIndex = trimmed.indexOf("\n---", 3);
  if (endIndex === -1) {
    throw new Error("SKILL.md frontmatter is missing closing delimiter (---).");
  }

  const yamlBlock = trimmed.slice(trimmed.indexOf("\n", 0) + 1, endIndex);
  const body = trimmed.slice(endIndex + 4).trim();
  const frontmatter = parseSimpleYaml(yamlBlock);

  return { frontmatter, body };
}

/**
 * Minimal YAML parser for flat key-value pairs, nested maps, and arrays.
 * Handles string values (quoted or unquoted), inline JSON objects/arrays,
 * YAML list syntax (`- item`), and multiple levels of nesting.
 */
export function parseSimpleYaml(yaml) {
  const result = {};
  const lines = yaml.split("\n");
  // Stack of { indent, obj, key } to track nesting context
  const stack = [{ indent: -1, obj: result, key: null }];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trim() === "" || line.trim().startsWith("#")) {
      continue;
    }

    // Calculate indentation (number of leading spaces)
    const indent = line.match(/^(\s*)/)[1].length;

    // Check for YAML list item: `- value`
    const listMatch = line.match(/^(\s*)-\s+(.*)/);
    if (listMatch) {
      const listValue = listMatch[2].trim();
      // Pop stack to find the parent array at the right indentation level
      while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
        stack.pop();
      }
      const parent = stack[stack.length - 1];
      if (Array.isArray(parent.obj)) {
        parent.obj.push(stripQuotes(listValue));
      }
      continue;
    }

    const match = line.match(/^(\s*)(\S+):\s*(.*)/);
    if (!match) continue;

    const key = match[2];
    const value = match[3].trim();

    // Pop stack to find the parent at the right indentation level
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].obj;

    if (value === "" || value === "|" || value === ">") {
      // Start of a nested object or array — peek ahead to determine which
      const nextNonEmpty = lines
        .slice(i + 1)
        .find((l) => l.trim() !== "" && !l.trim().startsWith("#"));
      if (nextNonEmpty && nextNonEmpty.match(/^\s*-\s+/)) {
        // Next meaningful line is a list item -> initialize as array
        parent[key] = [];
        stack.push({ indent, obj: parent[key], key });
      } else {
        parent[key] = {};
        stack.push({ indent, obj: parent[key], key });
      }
    } else if (
      (value.startsWith("{") && value.endsWith("}")) ||
      (value.startsWith("[") && value.endsWith("]"))
    ) {
      // Inline JSON
      try {
        parent[key] = JSON.parse(value);
      } catch {
        parent[key] = stripQuotes(value);
      }
    } else {
      parent[key] = stripQuotes(value);
    }
  }

  return result;
}

function stripQuotes(s) {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return processEscapes(s.slice(1, -1));
  }
  return s;
}

/**
 * Process JSON-style unicode escape sequences (\uXXXX) in a string.
 */
function processEscapes(s) {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}
