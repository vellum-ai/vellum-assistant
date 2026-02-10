"use client";

import {
  CircleAlert,
  CircleCheck,
  Info,
  OctagonX,
  X,
} from "lucide-react";
import { toast as sonnerToast, Toaster as SonnerToaster } from "sonner";

type ToastVariant = "default" | "info" | "warning" | "error" | "success";

interface ToastOptions {
  description?: string;
  duration?: number;
  action?: {
    label: string;
    onClick: () => void;
  };
}

const VARIANT_STYLES: Record<
  ToastVariant,
  { container: string; icon: string; iconElement: React.ReactNode }
> = {
  default: {
    container:
      "bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-white",
    icon: "text-zinc-500 dark:text-zinc-400",
    iconElement: null,
  },
  info: {
    container:
      "bg-blue-50 dark:bg-blue-950 border-blue-200 dark:border-blue-800 text-blue-900 dark:text-blue-100",
    icon: "text-blue-500 dark:text-blue-400",
    iconElement: <Info className="h-4 w-4" />,
  },
  warning: {
    container:
      "bg-amber-50 dark:bg-amber-950 border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-100",
    icon: "text-amber-500 dark:text-amber-400",
    iconElement: <CircleAlert className="h-4 w-4" />,
  },
  error: {
    container:
      "bg-red-50 dark:bg-red-950 border-red-200 dark:border-red-800 text-red-900 dark:text-red-100",
    icon: "text-red-500 dark:text-red-400",
    iconElement: <OctagonX className="h-4 w-4" />,
  },
  success: {
    container:
      "bg-green-50 dark:bg-green-950 border-green-200 dark:border-green-800 text-green-900 dark:text-green-100",
    icon: "text-green-500 dark:text-green-400",
    iconElement: <CircleCheck className="h-4 w-4" />,
  },
};

function showToast(
  message: string,
  variant: ToastVariant = "default",
  options?: ToastOptions
) {
  const styles = VARIANT_STYLES[variant];

  return sonnerToast.custom(
    (id) => (
      <div
        role="alert"
        className={`flex w-fit max-w-[356px] max-h-[300px] items-start gap-3 rounded-lg border p-3 shadow-lg ${styles.container}`}
      >
        {styles.iconElement && (
          <span className={`mt-0.5 shrink-0 ${styles.icon}`}>
            {styles.iconElement}
          </span>
        )}
        <div className="flex-1 space-y-1">
          <p className="text-sm font-medium leading-tight">{message}</p>
          {options?.description && (
            <p className="text-xs opacity-70">{options.description}</p>
          )}
          {options?.action && (
            <button
              onClick={() => {
                options.action?.onClick();
                sonnerToast.dismiss(id);
              }}
              className="mt-1.5 text-xs font-medium underline underline-offset-2 hover:no-underline"
            >
              {options.action.label}
            </button>
          )}
        </div>
        <button
          onClick={() => sonnerToast.dismiss(id)}
          aria-label="Close"
          className="shrink-0 rounded p-0.5 opacity-50 transition-opacity hover:opacity-100"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    ),
    { duration: options?.duration }
  );
}

const toast = Object.assign(
  (message: string, options?: ToastOptions) =>
    showToast(message, "default", options),
  {
    info: (message: string, options?: ToastOptions) =>
      showToast(message, "info", options),
    warning: (message: string, options?: ToastOptions) =>
      showToast(message, "warning", options),
    error: (message: string, options?: ToastOptions) =>
      showToast(message, "error", options),
    success: (message: string, options?: ToastOptions) =>
      showToast(message, "success", options),
  }
);

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

export { toast, Toaster };
export type { ToastVariant, ToastOptions };
