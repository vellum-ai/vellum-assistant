import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import {
  addToBlocklist,
  addToSafelist,
  loadPreferences,
  removeFromBlocklist,
  removeFromSafelist,
} from "./gmail-preferences.js";
import { err, ok } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const action = input.action as string;
  const emails = input.emails as string[] | undefined;

  switch (action) {
    case "list": {
      const prefs = loadPreferences();
      return ok(
        JSON.stringify({
          blocklist_count: prefs.blocklist.length,
          safelist_count: prefs.safelist.length,
          blocklist: prefs.blocklist,
          safelist: prefs.safelist,
        }),
      );
    }
    case "add_blocklist": {
      if (!emails?.length) return err("emails is required for add_blocklist");
      addToBlocklist(emails);
      return ok(`Added ${emails.length} sender(s) to blocklist.`);
    }
    case "add_safelist": {
      if (!emails?.length) return err("emails is required for add_safelist");
      addToSafelist(emails);
      return ok(`Added ${emails.length} sender(s) to safelist.`);
    }
    case "remove_blocklist": {
      if (!emails?.length)
        return err("emails is required for remove_blocklist");
      removeFromBlocklist(emails);
      return ok(`Removed ${emails.length} sender(s) from blocklist.`);
    }
    case "remove_safelist": {
      if (!emails?.length) return err("emails is required for remove_safelist");
      removeFromSafelist(emails);
      return ok(`Removed ${emails.length} sender(s) from safelist.`);
    }
    default:
      return err(
        `Unknown action "${action}". Use list, add_blocklist, add_safelist, remove_blocklist, or remove_safelist.`,
      );
  }
}
