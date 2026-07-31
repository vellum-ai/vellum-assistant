import type { ReactNode } from "react";

import type { TextRun } from "@/domains/chat/components/local-file/preview/ooxml";
import { PreviewRuns } from "@/domains/chat/components/local-file/preview/preview-runs";

interface DocxTableProps {
  /** Rows of cells, each cell holding the runs of every paragraph in it. */
  rows: TextRun[][][];
}

/**
 * A Word table rendered with the file-viewer table styling. Every row is a
 * body row: WordprocessingML marks header rows only as a repeat-across-pages
 * hint, which is not a reliable signal of a semantic header.
 */
export function DocxTable({ rows }: DocxTableProps): ReactNode {
  return (
    <div className="mb-3 overflow-x-auto last:mb-0">
      <table className="min-w-full border-collapse text-body-small-default">
        <tbody>
          {rows.map((cells, rowIndex) => (
            <tr key={rowIndex}>
              {cells.map((runs, cellIndex) => (
                <td
                  key={cellIndex}
                  className="border border-[var(--border-base)] px-2 py-1 align-top text-[var(--content-default)]"
                >
                  <PreviewRuns runs={runs} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
