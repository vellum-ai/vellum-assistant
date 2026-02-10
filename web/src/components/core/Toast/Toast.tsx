"use client";

import { Toaster as SonnerToaster } from "sonner";

type ToastVariant = "default" | "info" | "warning" | "error" | "success";

interface ToastOptions {
  description?: string;
  duration?: number;
  action?: {
    label: string;
    onClick: () => void;
  };
}

function Toaster() {
  return (
    <SonnerToaster
      position="bottom-right"
      toastOptions={{
        unstyled: true,
      }}
    />
  );
}

export { Toaster };
export type { ToastVariant, ToastOptions };
