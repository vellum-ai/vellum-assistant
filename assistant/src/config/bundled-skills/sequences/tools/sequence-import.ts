import { bulkEnroll, parseContactFile } from "../../../../sequence/importer.js";
import { getSequence } from "../../../../sequence/store.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const filePath = input.file_path as string;
  const sequenceId = input.sequence_id as string;
  const autoEnroll = input.auto_enroll as boolean | undefined;

  if (!filePath) return err("file_path is required.");
  if (!sequenceId) return err("sequence_id is required.");

  try {
    const seq = getSequence(sequenceId);
    if (!seq) return err(`Sequence not found: ${sequenceId}`);

    const parsed = parseContactFile(filePath);

    if (parsed.contacts.length === 0 && parsed.errors.length > 0) {
      return err(
        `No valid contacts found.\n\nErrors:\n${parsed.errors
          .map((e) => `  Row ${e.row}: ${e.reason}`)
          .join("\n")}`,
      );
    }

    // Preview mode (default) - show what would happen
    if (!autoEnroll) {
      const lines = [
        `Parsed ${parsed.contacts.length} valid contact(s) from file.`,
      ];
      if (parsed.errors.length > 0) {
        lines.push(`${parsed.errors.length} row(s) skipped:`);
        for (const e of parsed.errors.slice(0, 10)) {
          lines.push(`  Row ${e.row}: ${e.reason}`);
        }
        if (parsed.errors.length > 10)
          lines.push(`  ... and ${parsed.errors.length - 10} more`);
      }
      lines.push("");
      lines.push(`Sample contacts:`);
      for (const c of parsed.contacts.slice(0, 5)) {
        lines.push(`  ${c.email}${c.name ? ` (${c.name})` : ""}`);
      }
      if (parsed.contacts.length > 5)
        lines.push(`  ... and ${parsed.contacts.length - 5} more`);
      lines.push("");
      lines.push(
        `Call again with auto_enroll=true to enroll all ${parsed.contacts.length} contacts in "${seq.name}".`,
      );
      return ok(lines.join("\n"));
    }

    // Enroll mode
    const result = bulkEnroll(sequenceId, parsed.contacts);

    const lines = [
      `Enrollment complete for "${seq.name}":`,
      `  Enrolled: ${result.enrolled.length}`,
      `  Skipped:  ${result.skipped.length}`,
      `  Failed:   ${result.failed.length}`,
    ];

    if (result.skipped.length > 0) {
      lines.push("");
      lines.push("Skipped:");
      for (const s of result.skipped.slice(0, 10)) {
        lines.push(`  ${s.email} - ${s.reason}`);
      }
    }

    if (result.failed.length > 0) {
      lines.push("");
      lines.push("Failed:");
      for (const f of result.failed.slice(0, 10)) {
        lines.push(`  ${f.email} - ${f.reason}`);
      }
    }

    if (parsed.errors.length > 0) {
      lines.push("");
      lines.push(
        `${parsed.errors.length} row(s) in file had errors (not enrolled).`,
      );
    }

    return ok(lines.join("\n"));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
