import { AlertTriangle, File, Loader2, Upload, X } from "lucide-react";
import { type ChangeEvent, type DragEvent, useCallback, useRef, useState } from "react";

import { Button } from "@vellumai/design-library";
import { FileUploadSurfaceDataSchema } from "@vellumai/assistant-api";
import type { Surface } from "@/domains/chat/types/types";

import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";
import { cn } from "@/utils/misc";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FileUploadSurfaceProps {
  surface: Surface;
  onAction: (surfaceId: string, actionId: string, data?: Record<string, unknown>) => void;
}

interface SelectedFile {
  file: File;
  id: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Strip path separators from a filename to prevent path traversal in display. */
function sanitizeFilename(name: string): string {
  return name.replace(/[/\\]/g, "_");
}

/** Executable extensions that are suspicious when combined with a preceding extension. */
const SUSPICIOUS_EXECUTABLE_EXTS = new Set([
  ".exe", ".bat", ".cmd", ".com", ".msi", ".scr", ".pif", ".js", ".vbs", ".wsf",
]);

/** Check if a filename has a suspicious double extension (e.g. `.pdf.exe`). */
function hasSuspiciousDoubleExtension(name: string): boolean {
  const parts = name.split(".");
  if (parts.length < 3) return false;
  const lastExt = `.${parts[parts.length - 1]!.toLowerCase()}`;
  return SUSPICIOUS_EXECUTABLE_EXTS.has(lastExt);
}

/** Check whether a file's MIME type matches an accept-list entry.
 *
 *  Supports exact MIME types (`application/pdf`) and wildcard subtypes
 *  (`image/*`).  Extension-based patterns (`.pdf`) are matched against the
 *  file name.
 */
function fileMatchesType(file: File, acceptedType: string): boolean {
  const pattern = acceptedType.trim().toLowerCase();
  if (!pattern) return false;

  // Extension pattern, e.g. ".pdf"
  if (pattern.startsWith(".")) {
    return file.name.toLowerCase().endsWith(pattern);
  }

  const fileMime = file.type.toLowerCase();

  // Wildcard MIME, e.g. "image/*"
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -1); // "image/"
    return fileMime.startsWith(prefix);
  }

  // Exact MIME match
  return fileMime === pattern;
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip the data URL prefix (e.g. "data:image/png;base64,")
      const base64 = result.split(",")[1] ?? "";
      resolve(base64);
    };
    reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
    reader.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function FileUploadSurface({ surface, onAction }: FileUploadSurfaceProps) {
  // The wire keeps surface `data` opaque; narrow it with the canonical schema
  // (every field optional/coerced, so a real surface never fails to parse). The
  // schema also coerces `acceptedTypes` to a string[], the shape this
  // component's `.join`/`.some` calls require.
  const parsed = FileUploadSurfaceDataSchema.safeParse(surface.data);
  const data = parsed.success ? parsed.data : {};
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFiles, setSelectedFiles] = useState<SelectedFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [extensionWarning, setExtensionWarning] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  const acceptAttr = data.acceptedTypes?.join(",");

  const validateFiles = useCallback(
    (files: File[]): string | null => {
      if (data.maxFiles && files.length > data.maxFiles) {
        return `Too many files. Maximum allowed: ${data.maxFiles}`;
      }
      if (data.maxSizeBytes) {
        const oversized = files.find((f) => f.size > data.maxSizeBytes!);
        if (oversized) {
          return `File "${oversized.name}" exceeds the maximum size of ${formatFileSize(data.maxSizeBytes)}`;
        }
      }
      return null;
    },
    [data.maxFiles, data.maxSizeBytes],
  );

  const addFiles = useCallback(
    (newFiles: File[]) => {
      // Filter out files that don't match the accepted types (covers
      // drag-and-drop which bypasses the HTML `accept` attribute).
      let filesToAdd = newFiles;
      if (data.acceptedTypes && data.acceptedTypes.length > 0) {
        const rejected = newFiles.filter(
          (f) => !data.acceptedTypes!.some((t) => fileMatchesType(f, t)),
        );
        if (rejected.length > 0) {
          filesToAdd = newFiles.filter((f) =>
            data.acceptedTypes!.some((t) => fileMatchesType(f, t)),
          );
          const rejectMsg =
            rejected.length === 1
              ? `File type not accepted: ${rejected[0]!.name}`
              : `File types not accepted: ${rejected.map((f) => f.name).join(", ")}`;
          if (filesToAdd.length === 0) {
            setError(rejectMsg);
            return;
          }
          // Some files were accepted; show the rejection notice but continue.
          setError(rejectMsg);
        }
      }

      const combined = [...selectedFiles.map((sf) => sf.file), ...filesToAdd];
      const validationError = validateFiles(combined);
      if (validationError) {
        setError(validationError);
        return;
      }
      // Clear error only when all files passed type validation.
      if (filesToAdd.length === newFiles.length) {
        setError(null);
      }

      // Warn about suspicious double extensions across ALL selected files
      const suspicious = combined.filter((f) =>
        hasSuspiciousDoubleExtension(f.name),
      );
      if (suspicious.length > 0) {
        const names = suspicious.map((f) => sanitizeFilename(f.name)).join(", ");
        setExtensionWarning(
          `Suspicious file extension detected: ${names}. This file may not be what it appears.`,
        );
      } else {
        setExtensionWarning(null);
      }

      setSelectedFiles((prev) => [
        ...prev,
        ...filesToAdd.map((file) => ({ file, id: crypto.randomUUID() })),
      ]);
    },
    [selectedFiles, validateFiles, data.acceptedTypes],
  );

  const removeFile = useCallback((id: string) => {
    setSelectedFiles((prev) => {
      const next = prev.filter((sf) => sf.id !== id);
      // Clear extension warning if no remaining files have suspicious extensions
      const stillSuspicious = next.some((sf) =>
        hasSuspiciousDoubleExtension(sf.file.name),
      );
      if (!stillSuspicious) setExtensionWarning(null);
      return next;
    });
    setError(null);
  }, []);

  const handleFileChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length > 0) addFiles(files);
      // Reset the input so the same file can be re-selected
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [addFiles],
  );

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) addFiles(files);
    },
    [addFiles],
  );

  const handleSubmit = useCallback(async () => {
    if (selectedFiles.length === 0) return;
    setIsSubmitting(true);
    setError(null);

    try {
      const encodedFiles = await Promise.all(
        selectedFiles.map(async (sf) => {
          const content = await readFileAsBase64(sf.file);
          return {
            name: sanitizeFilename(sf.file.name),
            type: sf.file.type,
            size: sf.file.size,
            content,
          };
        }),
      );

      await onAction(surface.surfaceId, "submit", {
        files: encodedFiles,
      } as Record<string, unknown>);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to upload files");
      setIsSubmitting(false);
    }
  }, [selectedFiles, onAction, surface.surfaceId]);

  return (
    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-lift)] p-4">
      {surface.title && (
        <div className="mb-3 flex items-center gap-2">
          <span className="text-title-small text-[var(--content-strong)]">
            {surface.title}
          </span>
        </div>
      )}

      <ChatMarkdownMessage
        content={data.prompt ?? ""}
        className="mb-3 text-body-medium-lighter text-[var(--content-strong)]"
      />

      {/* Drop zone */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={cn(
          "flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed p-6 transition-colors",
          isDragOver
            ? "border-[var(--system-positive-strong)] bg-[var(--system-positive-weak)]"
            : "border-[var(--border-element)] bg-[var(--surface-sunken)] hover:border-[var(--content-faint)]",
        )}
      >
        <Upload
          className={cn(
            "h-8 w-8",
            isDragOver
              ? "text-[var(--system-positive-strong)]"
              : "text-[var(--content-faint)]",
          )}
        />
        <p className="text-body-medium-lighter text-[var(--content-quiet)]">
          Drag and drop files here, or click to browse
        </p>
        {data.acceptedTypes && data.acceptedTypes.length > 0 && (
          <p className="text-body-small-default text-[var(--content-faint)]">
            Accepted: {data.acceptedTypes.join(", ")}
          </p>
        )}
        {data.maxSizeBytes && (
          <p className="text-body-small-default text-[var(--content-faint)]">
            Max size: {formatFileSize(data.maxSizeBytes)}
          </p>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple={data.maxFiles !== 1}
        accept={acceptAttr}
        onChange={handleFileChange}
        className="hidden"
      />

      {/* File list */}
      {selectedFiles.length > 0 && (
        <ul className="mt-3 space-y-1">
          {selectedFiles.map((sf) => (
            <li
              key={sf.id}
              className="flex items-center gap-2 rounded-md bg-[var(--surface-sunken)] px-3 py-2 text-body-medium-lighter"
            >
              <File className="h-4 w-4 shrink-0 text-[var(--content-faint)]" />
              <span className="min-w-0 flex-1 truncate text-[var(--content-strong)]">
                {sanitizeFilename(sf.file.name)}
              </span>
              <span className="shrink-0 text-body-small-default text-[var(--content-faint)]">
                {formatFileSize(sf.file.size)}
              </span>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={(e) => {
                  e.stopPropagation();
                  removeFile(sf.id);
                }}
                className="shrink-0 rounded p-0.5 text-[var(--content-faint)] transition-colors hover:bg-[var(--surface-active)] hover:text-[var(--content-secondary)] disabled:opacity-50"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Error message */}
      {error && <p className="mt-2 text-body-small-default text-[var(--system-negative-strong)]">{error}</p>}

      {/* Suspicious extension warning */}
      {extensionWarning && (
        <div className="mt-2 flex items-center gap-1.5 text-body-small-default text-[var(--system-mid-strong)]">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {extensionWarning}
        </div>
      )}

      {/* Submit button */}
      <div className="mt-4 flex justify-end">
        <Button
          variant="primary"
          disabled={isSubmitting || selectedFiles.length === 0}
          onClick={handleSubmit}
          leftIcon={isSubmitting ? <Loader2 className="animate-spin" /> : <Upload />}
        >
          {isSubmitting ? "Uploading..." : "Upload"}
        </Button>
      </div>
    </div>
  );
}
