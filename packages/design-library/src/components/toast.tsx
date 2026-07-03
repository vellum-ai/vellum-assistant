import {
  CircleAlert,
  CircleCheck,
  Info,
  TriangleAlert,
  X,
} from "lucide-react";
import { type ReactElement, type ReactNode } from "react";
import { toast as sonnerToast, Toaster as SonnerToaster } from "sonner";

import { cn } from "../utils/cn";

/**
 * Toast notification system built on `sonner`.
 *
 * Provides an imperative `toast()` API with variant methods
 * (`toast.info()`, `toast.warning()`, `toast.error()`, `toast.success()`)
 * and a `<Toaster />` provider component.
 *
 * @see https://sonner.emilkowal.dev
 */

type ToastVariant = "default" | "info" | "warning" | "error" | "success";

interface ToastOptions {
  description?: string;
  duration?: number;
  action?: {
    label: string;
    onClick: () => void;
  };
  id?: string;
}

const ASSERTIVE_VARIANTS = new Set<ToastVariant>(["error", "warning"]);

const VARIANT_STYLES: Record<
  ToastVariant,
  { container: string; icon: string; iconElement: ReactNode }
> = {
  default: {
    container:
      "bg-[var(--surface-lift)] border-[var(--border-base)] text-[var(--content-default)]",
    icon: "text-[var(--content-tertiary)]",
    iconElement: null,
  },
  info: {
    container:
      "bg-[var(--surface-overlay)] border-[var(--border-element)] text-[var(--content-default)]",
    icon: "text-[var(--content-secondary)]",
    iconElement: <Info className="h-4 w-4" />,
  },
  warning: {
    container:
      "bg-[var(--system-mid-weak)] border-[var(--system-mid-strong)] text-[var(--system-mid-strong)]",
    icon: "text-[var(--system-mid-strong)]",
    iconElement: <CircleAlert className="h-4 w-4" />,
  },
  error: {
    container:
      "bg-[var(--system-negative-weak)] border-[var(--system-negative-strong)] text-[var(--system-negative-strong)]",
    icon: "text-[var(--system-negative-strong)]",
    iconElement: <TriangleAlert className="h-4 w-4" />,
  },
  success: {
    container:
      "bg-[var(--system-positive-weak)] border-[var(--system-positive-strong)] text-[var(--system-positive-strong)]",
    icon: "text-[var(--system-positive-strong)]",
    iconElement: <CircleCheck className="h-4 w-4" />,
  },
};

function ToastContent({
  message,
  variant = "default",
  options,
  onDismiss,
}: {
  message: string;
  variant?: ToastVariant;
  options?: ToastOptions;
  onDismiss: () => void;
}) {
  const styles = VARIANT_STYLES[variant];
  return (
    <div
      role={ASSERTIVE_VARIANTS.has(variant) ? "alert" : "status"}
      data-slot="toast"
      className={cn(
        "flex w-full max-h-[300px] items-start gap-3 rounded-lg border p-3 shadow-lg",
        styles.container,
      )}
    >
      {styles.iconElement ? (
        <span className={cn("mt-0.5 shrink-0", styles.icon)}>
          {styles.iconElement}
        </span>
      ) : null}
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-body-medium-default">{message}</p>
        {options?.description ? (
          <p className="text-body-small-default opacity-70">
            {options.description}
          </p>
        ) : null}
        {options?.action ? (
          <button
            type="button"
            onClick={() => {
              options.action?.onClick();
              onDismiss();
            }}
            className="mt-1.5 cursor-pointer bg-transparent text-body-small-default underline underline-offset-2 hover:no-underline"
          >
            {options.action.label}
          </button>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Close"
        className="shrink-0 cursor-pointer rounded bg-transparent p-0.5 opacity-50 transition-opacity hover:opacity-100"
      >
        <X className="h-3.5 w-3.5" strokeWidth={2} />
      </button>
    </div>
  );
}

function showToast(
  message: string,
  variant: ToastVariant = "default",
  options?: ToastOptions,
) {
  return sonnerToast.custom(
    (id) => (
      <ToastContent
        message={message}
        variant={variant}
        options={options}
        onDismiss={() => sonnerToast.dismiss(id)}
      />
    ),
    { duration: options?.duration, id: options?.id },
  );
}

interface CustomToastOptions {
  id?: string | number;
  duration?: number;
  onDismiss?: (toast: unknown) => void;
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
    custom: (
      render: (id: number | string) => ReactElement,
      options?: CustomToastOptions,
    ) => sonnerToast.custom(render, options),
    dismiss: (id?: string | number) => sonnerToast.dismiss(id),
  },
);

function Toaster() {
  return (
    <div data-slot="toaster">
      <SonnerToaster
        position="bottom-right"
        toastOptions={{
          unstyled: true,
          style: { width: "356px" },
        }}
      />
    </div>
  );
}

export { toast, Toaster, ToastContent };
export type { ToastVariant, ToastOptions };
