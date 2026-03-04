import { enrollContact, getSequence } from "../../../../sequence/store.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const sequenceId = input.sequence_id as string;
  const emails = input.emails as string | string[];
  const context = input.context as Record<string, unknown> | undefined;

  if (!sequenceId) return err("sequence_id is required.");
  if (!emails) return err("emails is required (string or array).");

  try {
    const seq = getSequence(sequenceId);
    if (!seq) return err(`Sequence not found: ${sequenceId}`);

    // Support comma-separated string or array
    const emailList = Array.isArray(emails)
      ? emails
      : emails
          .split(",")
          .map((e) => e.trim())
          .filter(Boolean);

    if (emailList.length === 0) return err("No valid emails provided.");

    const results: string[] = [];
    let successCount = 0;
    for (const email of emailList) {
      try {
        const enrollment = enrollContact({
          sequenceId,
          contactEmail: email,
          context,
        });
        results.push(`  ${email} — enrolled (ID: ${enrollment.id})`);
        successCount++;
      } catch (e) {
        results.push(
          `  ${email} — failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    return ok(
      `Enrolled ${successCount}/${emailList.length} contact(s) in "${
        seq.name
      }":\n${results.join("\n")}`,
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
