import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
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
type ToastTone = "weak" | "strong";

interface ToastOptions {
  description?: string;
  duration?: number;
  action?: {
    label: string;
    onClick: () => void;
  };
  id?: string;
  tone?: ToastTone;
}

const ASSERTIVE_VARIANTS = new Set<ToastVariant>(["error", "warning"]);

function variantStyles(
  variant: ToastVariant,
  tone: ToastTone,
): { container: string; iconElement: ReactNode } {
  const strong = tone === "strong";
  switch (variant) {
    case "success":
      return strong
        ? {
            container:
              "bg-[var(--system-positive-strong)] border-transparent text-white",
            iconElement: <CircleCheck className="h-4 w-4" />,
          }
        : {
            container:
              "bg-[var(--system-positive-weak)] border-transparent text-[var(--system-positive-strong)]",
            iconElement: <CircleCheck className="h-4 w-4" />,
          };
    case "error":
      return strong
        ? {
            container:
              "bg-[var(--system-negative-strong)] border-transparent text-white",
            iconElement: <CircleAlert className="h-4 w-4" />,
          }
        : {
            container:
              "bg-[var(--system-negative-weak)] border-transparent text-[var(--system-negative-strong)]",
            iconElement: <CircleAlert className="h-4 w-4" />,
          };
    case "warning":
      return strong
        ? {
            container:
              "bg-[var(--system-mid-strong)] border-transparent text-white",
            iconElement: <Info className="h-4 w-4" />,
          }
        : {
            container:
              "bg-[var(--system-mid-weak)] border-transparent text-[var(--system-mid-strong)]",
            iconElement: <Info className="h-4 w-4" />,
          };
    case "info":
      return strong
        ? {
            container:
              "bg-[var(--content-secondary)] border-transparent text-white",
            iconElement: <Info className="h-4 w-4" />,
          }
        : {
            container:
              "bg-[var(--surface-overlay)] border-transparent text-[var(--content-default)]",
            iconElement: <Info className="h-4 w-4" />,
          };
    case "default":
    default:
      return {
        container:
          "bg-[var(--surface-lift)] border-transparent text-[var(--content-default)]",
        iconElement: null,
      };
  }
}

function ToastContent({
  message,
  variant = "default",
  tone = "weak",
  options,
  onDismiss,
}: {
  message: string;
  variant?: ToastVariant;
  tone?: ToastTone;
  options?: ToastOptions;
  onDismiss: () => void;
}) {
  const styles = variantStyles(variant, tone);
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
        <span className="mt-0.5 shrink-0">{styles.iconElement}</span>
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

// Sonner builds the toast object as `{ jsx: jsx(id), id, ...data }`, so
// forwarding `id: undefined` overwrites the id it generated and handed to
// the jsx render callback — the stored toast ends up under a different id
// and dismissing by the callback's id (the close button) no-ops. Always
// hand sonner a concrete id of our own instead.
let toastIdCounter = 0;
function nextToastId(): string {
  return `toast-${++toastIdCounter}`;
}

function showToast(
  message: string,
  variant: ToastVariant = "default",
  options?: ToastOptions,
) {
  const id = options?.id ?? nextToastId();
  const tone = options?.tone ?? "weak";
  return sonnerToast.custom(
    () => (
      <ToastContent
        message={message}
        variant={variant}
        tone={tone}
        options={options}
        onDismiss={() => sonnerToast.dismiss(id)}
      />
    ),
    { duration: options?.duration, id },
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
    ) =>
      sonnerToast.custom(render, {
        ...options,
        id: options?.id ?? nextToastId(),
      }),
    dismiss: (id?: string | number) => sonnerToast.dismiss(id),
  },
);

function Toaster() {
  return (
    <div data-slot="toaster">
      {/* Sonner's ≤600px media query drops the translateX centering and
          anchors toasts at `left: 0; right: 0` inside an offset container,
          and it reads `mobileOffset` (not `offset`) there. Zero the side
          offsets so the container spans the viewport, and let the auto
          margins center the fixed-width toast; the maxWidth clamp keeps
          16px gutters on screens narrower than the toast. */}
      <SonnerToaster
        position="bottom-center"
        offset="24px"
        mobileOffset={{
          left: 0,
          right: 0,
          bottom:
            "calc(24px + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))",
        }}
        toastOptions={{
          unstyled: true,
          style: {
            width: "356px",
            maxWidth: "calc(100vw - 32px)",
            marginInline: "auto",
          },
        }}
      />
    </div>
  );
}

export { toast, Toaster, ToastContent };
export type { ToastVariant, ToastTone, ToastOptions };
