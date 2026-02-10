"use client";

import { Loader2 } from "lucide-react";

import { Button } from "@/components/app/core/Button";

interface HatchingModalProps {
  error: string | null;
  onDismissError: () => void;
}

export function HatchingModal({ error, onDismissError }: HatchingModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-sm rounded-xl bg-white p-8 text-center shadow-2xl dark:bg-zinc-900">
        {error ? (
          <>
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-100 dark:bg-red-950">
              <span className="text-2xl text-red-600 dark:text-red-400">!</span>
            </div>
            <h2 className="mb-2 text-lg font-semibold text-zinc-900 dark:text-white">
              Hatching Failed
            </h2>
            <p className="mb-4 text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
            <Button onClick={onDismissError}>
              Try Again
            </Button>
          </>
        ) : (
          <>
            <Loader2 className="mx-auto mb-4 h-10 w-10 animate-spin text-indigo-600" />
            <h2 className="mb-2 text-lg font-semibold text-zinc-900 dark:text-white">
              Hatching Your Assistant...
            </h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              This may take a moment. Please don&apos;t close this page.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
