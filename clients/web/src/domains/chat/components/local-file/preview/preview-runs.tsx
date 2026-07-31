import type { ReactNode } from "react";

import type { TextRun } from "@/domains/chat/components/local-file/preview/ooxml";

interface PreviewRunsProps {
  runs: TextRun[];
}

function renderRun(run: TextRun, key: number): ReactNode {
  if (run.bold && run.italic) {
    return (
      <strong key={key}>
        <em>{run.text}</em>
      </strong>
    );
  }
  if (run.bold) {
    return <strong key={key}>{run.text}</strong>;
  }
  if (run.italic) {
    return <em key={key}>{run.text}</em>;
  }
  return <span key={key}>{run.text}</span>;
}

/**
 * Render a sequence of OOXML text runs as inline content, carrying over the
 * only two run properties the previews keep.
 */
export function PreviewRuns({ runs }: PreviewRunsProps): ReactNode {
  return <>{runs.map((run, index) => renderRun(run, index))}</>;
}
