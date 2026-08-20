/**
 * Read-only grid for a delimited text file (`.csv`, `.tsv`) opened in the
 * document drawer.
 *
 * Rows are virtualized: an exported spreadsheet routinely runs to thousands of
 * rows, and mounting a `<tr>` per row would cost more than reading the file.
 * `TableVirtuoso` renders real table elements with a sticky header, so the grid
 * keeps table semantics (screen readers, column alignment) while only the
 * visible slice is in the DOM.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { TableVirtuoso, type TableComponents } from "react-virtuoso";

import { Typography } from "@vellumai/design-library";

import { parseCsv } from "@/domains/chat/components/local-file/preview/csv";
import { PreviewError } from "@/domains/chat/components/local-file/preview/preview-error";
import { PreviewSkeleton } from "@/domains/chat/components/local-file/preview/preview-skeleton";

/**
 * Rows rendered before the viewport is measured. Virtuoso needs a height to
 * decide what is visible, and there is none on the first paint (nor in a
 * headless test DOM), so this seeds a first screenful that the real
 * measurement then takes over from.
 */
const INITIAL_ROW_COUNT = 30;

const CELL_CLASSES =
  "border-b border-r border-[var(--border-element)] px-2 py-1 align-top last:border-r-0";

const TABLE_COMPONENTS: TableComponents<string[]> = {
  Table: ({ style, ...props }) => (
    <table
      {...props}
      // `min-w-max` keeps narrow cells at their natural width and lets a wide
      // file scroll sideways inside the scroller rather than squeezing.
      className="w-full min-w-max border-collapse text-body-small-default text-[var(--content-default)]"
      style={style}
    />
  ),
  TableRow: ({ item: _item, ...props }) => <tr {...props} />,
};

interface CsvPreviewProps {
  blob: Blob;
  filename: string;
}

export function CsvPreview({ blob, filename }: CsvPreviewProps): ReactNode {
  const [text, setText] = useState<string | null>(null);
  const [decodeFailed, setDecodeFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setText(null);
    setDecodeFailed(false);
    // `Blob.text()` decodes as UTF-8, which is what the daemon writes and what
    // every other text surface in the app assumes.
    blob.text().then(
      (decoded) => {
        if (!cancelled) {
          setText(decoded);
        }
      },
      () => {
        if (!cancelled) {
          setDecodeFailed(true);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [blob]);

  const parsed = useMemo(
    () => (text === null ? null : parseCsv(text)),
    [text],
  );

  const headers = parsed?.headers ?? null;
  const fixedHeaderContent = useCallback(() => {
    if (headers === null) {
      return null;
    }
    return (
      <tr>
        {headers.map((cell, index) => (
          <th
            // Header labels repeat in real files, so the column index is the
            // only stable identity here.
            key={index}
            scope="col"
            title={cell}
            className={`${CELL_CLASSES} bg-[var(--surface-sunken)] text-left text-body-small-emphasised`}
          >
            <span className="block max-w-[20rem] truncate">{cell}</span>
          </th>
        ))}
      </tr>
    );
  }, [headers]);

  if (decodeFailed) {
    return <PreviewError filename={filename} />;
  }
  if (parsed === null) {
    return <PreviewSkeleton />;
  }

  const columnCount = headers?.length ?? parsed.rows[0]?.length ?? 0;
  if (columnCount === 0) {
    return (
      <div
        role="status"
        className="flex h-full items-center justify-center p-4"
      >
        <Typography
          as="span"
          variant="body-small-default"
          className="text-[var(--content-tertiary)]"
        >
          This file is empty
        </Typography>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TableVirtuoso
        data={parsed.rows}
        initialItemCount={Math.min(parsed.rows.length, INITIAL_ROW_COUNT)}
        components={TABLE_COMPONENTS}
        fixedHeaderContent={headers === null ? undefined : fixedHeaderContent}
        itemContent={(_index, row) =>
          row.map((cell, columnIndex) => (
            <td key={columnIndex} title={cell} className={CELL_CLASSES}>
              <span className="block max-w-[20rem] truncate">{cell}</span>
            </td>
          ))
        }
        className="min-h-0 flex-1"
      />
      <Typography
        as="p"
        variant="label-small-default"
        className="shrink-0 border-t border-[var(--border-element)] px-3 py-1.5 text-[var(--content-tertiary)]"
      >
        {`${parsed.rows.length} rows x ${columnCount} columns`}
        {parsed.truncated ? " (truncated)" : ""}
      </Typography>
    </div>
  );
}
