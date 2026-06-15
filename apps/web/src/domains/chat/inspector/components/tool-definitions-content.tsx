import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

import type { ParsedToolDefinition } from "@/domains/chat/inspector/tool-definitions";
import { Collapsible, Tag } from "@vellumai/design-library";

interface ToolDefinitionsContentProps {
  tools: ParsedToolDefinition[];
}

/**
 * First-class rendering of a request's tool definitions: a short intro
 * line plus a list of tools by name, each expandable to show its
 * description and input schema as a structured property breakdown. Meant
 * to be embedded inside a prompt section card. The raw provider JSON stays
 * on the Raw tab.
 */
export function ToolDefinitionsContent({
  tools,
}: ToolDefinitionsContentProps): ReactNode {
  return (
    <div>
      <p
        className="text-body-medium-lighter"
        style={{ color: "var(--content-secondary)" }}
      >
        {tools.length} tool{tools.length === 1 ? "" : "s"} sent with this
        request. Expand a tool to see its definition and input schema.
      </p>
      <Collapsible.Root
        type="multiple"
        defaultValue={tools.length === 1 ? tools.map((t) => t.name) : undefined}
        className="mt-3"
      >
        {tools.map((tool, i) => (
          <ToolRow key={`${tool.name}-${i}`} tool={tool} />
        ))}
      </Collapsible.Root>
    </div>
  );
}

function ToolRow({ tool }: { tool: ParsedToolDefinition }): ReactNode {
  return (
    <Collapsible.Item
      value={tool.name}
      className="border-t"
      style={{ borderColor: "var(--border-base)" }}
    >
      <Collapsible.Trigger className="group gap-2 py-2 text-left">
        <ChevronRight
          size={14}
          aria-hidden
          className="shrink-0 transition-transform group-data-[state=open]:rotate-90"
          style={{ color: "var(--content-tertiary)" }}
        />
        <span
          className="truncate font-mono text-body-small-default"
          style={{ color: "var(--content-default)" }}
        >
          {tool.name}
        </span>
        {tool.type && <Tag>{tool.type}</Tag>}
        {tool.description && (
          <span
            className="min-w-0 flex-1 truncate text-label-default"
            style={{ color: "var(--content-tertiary)" }}
          >
            {tool.description}
          </span>
        )}
      </Collapsible.Trigger>
      <Collapsible.Content>
        <div className="flex flex-col gap-3 pb-3 pl-6">
          {tool.description && (
            <p
              className="select-text whitespace-pre-wrap break-words text-body-small-default"
              style={{ color: "var(--content-secondary)" }}
            >
              {tool.description}
            </p>
          )}
          {tool.inputSchema ? (
            <div>
              <p
                className="mb-1 text-label-default"
                style={{ color: "var(--content-tertiary)" }}
              >
                Input schema
              </p>
              <SchemaNode schema={tool.inputSchema} depth={0} />
            </div>
          ) : (
            <p
              className="text-label-default"
              style={{ color: "var(--content-tertiary)" }}
            >
              No input schema — this tool takes no structured input.
            </p>
          )}
          {Object.keys(tool.extras).length > 0 && (
            <div>
              <p
                className="mb-1 text-label-default"
                style={{ color: "var(--content-tertiary)" }}
              >
                Settings
              </p>
              <dl className="flex flex-col gap-0.5">
                {Object.entries(tool.extras).map(([key, value]) => (
                  <div key={key} className="flex items-baseline gap-2">
                    <dt
                      className="font-mono text-body-small-default"
                      style={{ color: "var(--content-default)" }}
                    >
                      {key}
                    </dt>
                    <dd
                      className="min-w-0 break-words font-mono text-body-small-default"
                      style={{ color: "var(--content-secondary)" }}
                    >
                      {formatScalar(value)}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </div>
      </Collapsible.Content>
    </Collapsible.Item>
  );
}

const MAX_SCHEMA_DEPTH = 6;

/**
 * Renders a JSON Schema node as a nested property breakdown. Objects
 * list their properties (with required markers), arrays describe their
 * item schema, and leaves show type/enum/default annotations.
 */
function SchemaNode({
  schema,
  depth,
}: {
  schema: Record<string, unknown>;
  depth: number;
}): ReactNode {
  if (depth >= MAX_SCHEMA_DEPTH) {
    return <SchemaLeafSummary schema={schema} />;
  }

  const properties = isRecord(schema.properties) ? schema.properties : null;
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((r): r is string => typeof r === "string")
      : [],
  );

  if (properties && Object.keys(properties).length > 0) {
    return (
      <ul
        className={depth > 0 ? "border-l pl-3" : undefined}
        style={depth > 0 ? { borderColor: "var(--border-base)" } : undefined}
      >
        {Object.entries(properties).map(([name, propSchema]) => (
          <SchemaProperty
            key={name}
            name={name}
            schema={isRecord(propSchema) ? propSchema : {}}
            isRequired={required.has(name)}
            depth={depth}
          />
        ))}
      </ul>
    );
  }

  return <SchemaLeafSummary schema={schema} />;
}

function SchemaProperty({
  name,
  schema,
  isRequired,
  depth,
}: {
  name: string;
  schema: Record<string, unknown>;
  isRequired: boolean;
  depth: number;
}): ReactNode {
  const description =
    typeof schema.description === "string" ? schema.description : null;
  const items = isRecord(schema.items) ? schema.items : null;
  const hasNestedObject =
    isRecord(schema.properties) && Object.keys(schema.properties).length > 0;
  const nestedItems = items && isRecord(items.properties) ? items : null;

  return (
    <li className="py-1">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span
          className="font-mono text-body-small-default"
          style={{ color: "var(--content-default)" }}
        >
          {name}
        </span>
        <span
          className="font-mono text-label-default"
          style={{ color: "var(--content-tertiary)" }}
        >
          {schemaTypeLabel(schema)}
        </span>
        {isRequired && (
          <span
            className="text-label-default"
            style={{ color: "var(--content-attention, var(--content-secondary))" }}
          >
            required
          </span>
        )}
        {schema.default !== undefined && (
          <span
            className="font-mono text-label-default"
            style={{ color: "var(--content-tertiary)" }}
          >
            default: {formatScalar(schema.default)}
          </span>
        )}
      </div>
      {description && (
        <p
          className="mt-0.5 select-text whitespace-pre-wrap break-words text-label-default"
          style={{ color: "var(--content-secondary)" }}
        >
          {description}
        </p>
      )}
      {hasNestedObject && (
        <div className="mt-1">
          <SchemaNode schema={schema} depth={depth + 1} />
        </div>
      )}
      {!hasNestedObject && nestedItems && (
        <div className="mt-1">
          <SchemaNode schema={nestedItems} depth={depth + 1} />
        </div>
      )}
    </li>
  );
}

/** Compact annotation line for schemas without object properties. */
function SchemaLeafSummary({
  schema,
}: {
  schema: Record<string, unknown>;
}): ReactNode {
  return (
    <p
      className="font-mono text-label-default"
      style={{ color: "var(--content-tertiary)" }}
    >
      {schemaTypeLabel(schema)}
    </p>
  );
}

function schemaTypeLabel(schema: Record<string, unknown>): string {
  const enumValues = Array.isArray(schema.enum) ? schema.enum : null;
  if (enumValues && enumValues.length > 0) {
    return enumValues.map(formatScalar).join(" | ");
  }
  const type = schema.type;
  if (typeof type === "string") {
    if (type === "array") {
      const items = isRecord(schema.items) ? schema.items : null;
      return items ? `${schemaTypeLabel(items)}[]` : "array";
    }
    return type;
  }
  if (Array.isArray(type)) {
    return type.filter((t): t is string => typeof t === "string").join(" | ");
  }
  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    const variants = (schema.anyOf ?? schema.oneOf) as unknown[];
    return variants
      .map((v) => (isRecord(v) ? schemaTypeLabel(v) : "unknown"))
      .join(" | ");
  }
  return "object";
}

function formatScalar(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
