import { loadAllAssistants } from "../lib/assistant-config";
import { checkHealth } from "../lib/health-check";
import { withStatusEmoji } from "../lib/status-emoji";

interface TableRow {
  name: string;
  status: string;
  info: string;
}

interface ColWidths {
  name: number;
  status: number;
  info: number;
}

function pad(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - s.length));
}

function computeColWidths(rows: TableRow[]): ColWidths {
  const headers: TableRow = { name: "NAME", status: "STATUS", info: "INFO" };
  const all = [headers, ...rows];
  return {
    name: Math.max(...all.map((r) => r.name.length)),
    status: Math.max(...all.map((r) => r.status.length), "checking...".length),
    info: Math.max(...all.map((r) => r.info.length)),
  };
}

function formatRow(r: TableRow, colWidths: ColWidths): string {
  return `  ${pad(r.name, colWidths.name)}  ${pad(r.status, colWidths.status)}  ${r.info}`;
}

export async function ps(): Promise<void> {
  const assistants = loadAllAssistants();

  if (assistants.length === 0) {
    console.log("No assistants found.");
    return;
  }

  const rows: TableRow[] = assistants.map((a) => {
    const infoParts = [a.runtimeUrl];
    if (a.cloud) infoParts.push(`cloud: ${a.cloud}`);
    if (a.species) infoParts.push(`species: ${a.species}`);

    return {
      name: a.assistantId,
      status: withStatusEmoji("checking..."),
      info: infoParts.join(" | "),
    };
  });

  const colWidths = computeColWidths(rows);

  const headers: TableRow = { name: "NAME", status: "STATUS", info: "INFO" };
  console.log(formatRow(headers, colWidths));
  const sep = `  ${"-".repeat(colWidths.name)}  ${"-".repeat(colWidths.status)}  ${"-".repeat(colWidths.info)}`;
  console.log(sep);
  for (const row of rows) {
    console.log(formatRow(row, colWidths));
  }

  const totalDataRows = rows.length;

  await Promise.all(
    assistants.map(async (a, rowIndex) => {
      const health = await checkHealth(a.runtimeUrl);

      const infoParts = [a.runtimeUrl];
      if (a.cloud) infoParts.push(`cloud: ${a.cloud}`);
      if (a.species) infoParts.push(`species: ${a.species}`);
      if (health.detail) infoParts.push(health.detail);

      const updatedRow: TableRow = {
        name: a.assistantId,
        status: withStatusEmoji(health.status),
        info: infoParts.join(" | "),
      };

      const linesUp = totalDataRows - rowIndex;
      process.stdout.write(
        `\x1b[${linesUp}A` +
          `\r\x1b[K` +
          formatRow(updatedRow, colWidths) +
          `\n` +
          (linesUp > 1 ? `\x1b[${linesUp - 1}B` : ""),
      );
    }),
  );
}
