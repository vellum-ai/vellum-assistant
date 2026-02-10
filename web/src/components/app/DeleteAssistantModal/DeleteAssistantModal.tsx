"use client";

import { Loader2, Trash2 } from "lucide-react";
import { MouseEvent, useCallback, useRef } from "react";

import { Button } from "@/components/app/core/Button";

interface DeleteAssistantModalProps {
  isDeleting: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

export function DeleteAssistantModal({
  isDeleting,
  error,
  onConfirm,
  onClose,
}: DeleteAssistantModalProps) {
  const backdropRef = useRef<HTMLDivElement>(null);

  const handleBackdropClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (e.target === backdropRef.current && !isDeleting) {
        onClose();
      }
    },
    [onClose, isDeleting]
  );

  return (
    <div
      ref={backdropRef}
      onClick={handleBackdropClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div className="w-full max-w-sm rounded-xl bg-white p-8 text-center shadow-2xl dark:bg-zinc-900">
        {isDeleting ? (
          <>
            <Loader2 className="mx-auto mb-4 h-10 w-10 animate-spin text-red-600" />
            <h2 className="mb-2 text-lg font-semibold text-zinc-900 dark:text-white">
              Deleting Assistant...
            </h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              This may take a moment. Please don&apos;t close this page.
            </p>
          </>
        ) : error ? (
          <>
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-100 dark:bg-red-950">
              <span className="text-2xl text-red-600 dark:text-red-400">!</span>
            </div>
            <h2 className="mb-2 text-lg font-semibold text-zinc-900 dark:text-white">
              Deletion Failed
            </h2>
            <p className="mb-4 text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
            <div className="flex gap-3">
              <Button
                onClick={onClose}
                variant="outline"
                className="flex-1"
              >
                Cancel
              </Button>
              <Button
                onClick={onConfirm}
                variant="danger"
                className="flex-1"
              >
                Retry
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-100 dark:bg-red-950">
              <Trash2 className="h-6 w-6 text-red-600 dark:text-red-400" />
            </div>
            <h2 className="mb-2 text-lg font-semibold text-zinc-900 dark:text-white">
              Delete Assistant
            </h2>
            <p className="mb-6 text-sm text-zinc-500 dark:text-zinc-400">
              Are you sure you want to delete this assistant? This action cannot
              be undone.
            </p>
            <div className="flex gap-3">
              <Button
                onClick={onClose}
                variant="outline"
                className="flex-1"
              >
                Cancel
              </Button>
              <Button
                onClick={onConfirm}
                variant="danger"
                icon={Trash2}
                className="flex-1"
              >
                Delete
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
