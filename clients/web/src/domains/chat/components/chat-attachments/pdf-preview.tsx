import { PreviewMessageCard } from "@/domains/chat/components/chat-attachments/preview-message-card";

interface PdfPreviewProps {
  url: string;
  filename: string;
  onDownload: () => void;
  className?: string;
}

export function PdfPreview({
  url,
  filename,
  onDownload,
  className,
}: PdfPreviewProps) {
  return (
    <object
      data={url}
      type="application/pdf"
      aria-label={`Preview of ${filename}`}
      className={`h-[80vh] w-[90vw] max-w-[1000px] rounded border-0 bg-white ${className ?? ""}`}
    >
      <PreviewMessageCard
        message="PDF preview unavailable."
        filename={filename}
        onDownload={onDownload}
      />
    </object>
  );
}
