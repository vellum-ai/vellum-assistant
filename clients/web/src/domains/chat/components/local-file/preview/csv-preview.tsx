/**
 * Read-only grid for a delimited text file (`.csv`, `.tsv`) opened in the
 * document drawer.
 *
 * This file owns the decode: it reads the blob as UTF-8 text and parses it.
 * The grid it hands the result to lives in `tabular-grid.tsx`.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";

import { parseCsv } from "@/domains/chat/components/local-file/preview/csv";
import { PreviewError } from "@/domains/chat/components/local-file/preview/preview-error";
import { PreviewSkeleton } from "@/domains/chat/components/local-file/preview/preview-skeleton";
import { TabularGrid } from "@/domains/chat/components/local-file/preview/tabular-grid";

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

  const parsed = useMemo(() => (text === null ? null : parseCsv(text)), [text]);

  if (decodeFailed) {
    return <PreviewError filename={filename} />;
  }
  if (parsed === null) {
    return <PreviewSkeleton />;
  }

  return <TabularGrid {...parsed} />;
}
