/**
 * Read-only grid for a delimited text file (`.csv`, `.tsv`) opened in the
 * document drawer.
 *
 * This file owns the decode: it reads the blob as UTF-8 text and parses it.
 * The grid it hands the result to lives in `tabular-grid.tsx`.
 */

import { useMemo, type ReactNode } from "react";

import { parseCsv } from "@/domains/chat/components/local-file/preview/csv";
import { PreviewError } from "@/domains/chat/components/local-file/preview/preview-error";
import { PreviewSkeleton } from "@/domains/chat/components/local-file/preview/preview-skeleton";
import { TabularGrid } from "@/domains/chat/components/local-file/preview/tabular-grid";
import { useAsyncRead } from "@/domains/chat/components/local-file/preview/use-async-read";

interface CsvPreviewProps {
  blob: Blob;
  filename: string;
}

export function CsvPreview({ blob, filename }: CsvPreviewProps): ReactNode {
  const { value: text, failed: decodeFailed } = useAsyncRead(blob, (source) =>
    source.text(),
  );

  const parsed = useMemo(() => (text === null ? null : parseCsv(text)), [text]);

  if (decodeFailed) {
    return <PreviewError filename={filename} />;
  }
  if (parsed === null) {
    return <PreviewSkeleton />;
  }

  return <TabularGrid {...parsed} />;
}
