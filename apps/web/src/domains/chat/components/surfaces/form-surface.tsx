import { ChevronLeft, ChevronRight, Loader2, Lock, Send, Shield } from "lucide-react";
import { type FormEvent, useCallback, useMemo, useState } from "react";

import type { Surface } from "@/domains/chat/types/types";
import { Button, Toggle } from "@vellumai/design-library";

import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FormFieldOption {
  label: string;
  value: string;
}

interface FormField {
  id: string;
  type: "text" | "textarea" | "select" | "toggle" | "number" | "password";
  label: string;
  placeholder?: string;
  required?: boolean;
  defaultValue?: string | number | boolean;
  options?: FormFieldOption[];
}

interface FormPage {
  id: string;
  title: string;
  description?: string;
  fields: FormField[];
}

interface FormSurfaceData {
  description?: string;
  fields?: FormField[];
  submitLabel?: string;
  pages?: FormPage[];
  pageLabels?: {
    next?: string;
    back?: string;
    submit?: string;
  };
}

interface FormSurfaceProps {
  surface: Surface;
  onAction: (surfaceId: string, actionId: string, data?: Record<string, unknown>) => void;
}

// ---------------------------------------------------------------------------
// Field rendering
// ---------------------------------------------------------------------------

function renderField(
  field: FormField,
  value: string | number | boolean,
  onChange: (id: string, value: string | number | boolean) => void,
  validationErrors: Record<string, string>,
) {
  const errorMsg = validationErrors[field.id];
  const inputClasses =
    "w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--field-bg)] px-3 py-2 text-body-medium-lighter text-[var(--content-default)] focus:border-[var(--primary-base)] focus:outline-none focus:ring-1 focus:ring-[var(--primary-base)]";
  const errorClasses = errorMsg
    ? " border-[var(--system-negative-strong)]"
    : "";

  switch (field.type) {
    case "text":
      return (
        <input
          type="text"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(field.id, e.target.value)}
          placeholder={field.placeholder}
          className={inputClasses + errorClasses}
        />
      );

    case "password":
      return (
        <div>
          <input
            type="password"
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(field.id, e.target.value)}
            placeholder={field.placeholder}
            className={inputClasses + errorClasses}
          />
          <p className="mt-1 flex items-center gap-1 text-body-small-default text-[var(--content-faint)]">
            <Lock className="h-3 w-3" />
            This value will be sent securely and will not be stored in your browser.
          </p>
        </div>
      );

    case "textarea":
      return (
        <textarea
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(field.id, e.target.value)}
          placeholder={field.placeholder}
          rows={3}
          className={inputClasses + errorClasses + " resize-none"}
        />
      );

    case "select":
      return (
        <select
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(field.id, e.target.value)}
          className={inputClasses + errorClasses}
        >
          <option value="">{field.placeholder || "Select..."}</option>
          {(field.options ?? []).map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      );

    case "toggle":
      return (
        <Toggle
          checked={!!value}
          onChange={(next) => onChange(field.id, next)}
          aria-label={field.label}
        />
      );

    case "number":
      return (
        <input
          type="number"
          value={typeof value === "number" ? value : typeof value === "string" ? value : ""}
          onChange={(e) => {
            const num = e.target.value === "" ? "" : Number(e.target.value);
            onChange(field.id, num);
          }}
          placeholder={field.placeholder}
          className={inputClasses + errorClasses}
        />
      );

    default:
      return (
        <input
          type="text"
          value={typeof value === "string" ? value : String(value)}
          onChange={(e) => onChange(field.id, e.target.value)}
          placeholder={field.placeholder}
          className={inputClasses + errorClasses}
        />
      );
  }
}

// ---------------------------------------------------------------------------
// Progress indicator for multi-page forms
// ---------------------------------------------------------------------------

function PageProgress({ current, total }: { current: number; total: number }) {
  return (
    <div className="mb-4 flex items-center gap-1.5">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={`h-1.5 flex-1 rounded-full transition-colors ${
            i <= current ? "bg-[var(--primary-base)]" : "bg-[var(--border-subtle)]"
          }`}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function FormSurface({ surface, onAction }: FormSurfaceProps) {
  const formData = surface.data as unknown as FormSurfaceData;
  const isMultiPage = formData.pages && formData.pages.length > 0;
  const allPages: FormPage[] = useMemo(
    () =>
      isMultiPage
        ? formData.pages!
        : [{ id: "default", title: "", fields: formData.fields ?? [] }],
    [isMultiPage, formData.pages, formData.fields],
  );
  const totalPages = allPages.length;

  const [currentPage, setCurrentPage] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});

  // Build initial values from defaultValues
  const [values, setValues] = useState<Record<string, string | number | boolean>>(() => {
    const initial: Record<string, string | number | boolean> = {};
    for (const page of allPages) {
      for (const field of page.fields) {
        if (field.defaultValue !== undefined) {
          initial[field.id] = field.defaultValue;
        } else if (field.type === "toggle") {
          initial[field.id] = false;
        } else if (field.type === "number") {
          initial[field.id] = "";
        } else {
          initial[field.id] = "";
        }
      }
    }
    return initial;
  });

  const handleChange = useCallback((id: string, value: string | number | boolean) => {
    setValues((prev) => ({ ...prev, [id]: value }));
    setValidationErrors((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const validatePage = useCallback(
    (pageIndex: number): boolean => {
      const page = allPages[pageIndex];
      if (!page) return true;
      const errors: Record<string, string> = {};
      for (const field of page.fields) {
        if (field.required) {
          const val = values[field.id];
          if (val === undefined || val === "" || val === null) {
            errors[field.id] = "This field is required";
          }
        }
      }
      setValidationErrors(errors);
      return Object.keys(errors).length === 0;
    },
    [allPages, values],
  );

  const handleNext = useCallback(() => {
    if (!validatePage(currentPage)) return;
    setCurrentPage((prev) => Math.min(prev + 1, totalPages - 1));
  }, [currentPage, totalPages, validatePage]);

  const handleBack = useCallback(() => {
    setValidationErrors({});
    setCurrentPage((prev) => Math.max(prev - 1, 0));
  }, []);

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!validatePage(currentPage)) return;
      setIsSubmitting(true);
      try {
        await onAction(surface.surfaceId, "submit", values as Record<string, unknown>);
      } catch {
        setIsSubmitting(false);
      }
    },
    [currentPage, onAction, surface.surfaceId, validatePage, values],
  );

  const currentPageData = allPages[currentPage];
  if (!currentPageData) return null;
  const isLastPage = currentPage === totalPages - 1;
  const hasPasswordFields = allPages.some((page) =>
    page.fields.some((field) => field.type === "password"),
  );

  const nextLabel = formData.pageLabels?.next ?? "Next";
  const backLabel = formData.pageLabels?.back ?? "Back";
  const submitLabel = isMultiPage
    ? (formData.pageLabels?.submit ?? "Submit")
    : (formData.submitLabel ?? "Submit");

  return (
    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-lift)] p-4">
      {surface.title && (
        <div className="mb-3 flex items-center gap-2">
          <span className="text-title-small text-[var(--content-strong)]">
            {surface.title}
          </span>
        </div>
      )}

      {isMultiPage && totalPages > 1 && (
        <PageProgress current={currentPage} total={totalPages} />
      )}

      {currentPageData.title && isMultiPage && (
        <h3 className="mb-1 text-title-small text-[var(--content-strong)]">
          {currentPageData.title}
        </h3>
      )}

      {(currentPageData.description || (!isMultiPage && formData.description)) && (
        <ChatMarkdownMessage
          content={(isMultiPage ? currentPageData.description : formData.description) ?? ""}
          className="mb-3 text-body-medium-lighter text-[var(--content-quiet)]"
        />
      )}

      <form onSubmit={handleSubmit} className="space-y-3">
        {currentPageData.fields.map((field) => (
          <div key={field.id}>
            <label className="mb-1 block text-body-medium-default text-[var(--content-strong)]">
              {field.label}
              {field.required && (
                <span className="ml-0.5 text-[var(--system-negative-strong)]">*</span>
              )}
            </label>
            {renderField(field, values[field.id] ?? "", handleChange, validationErrors)}
            {validationErrors[field.id] && (
              <p className="mt-1 text-body-small-default text-[var(--system-negative-strong)]">
                {validationErrors[field.id]}
              </p>
            )}
          </div>
        ))}

        <div className="flex items-center justify-between pt-2">
          <div>
            {isMultiPage && currentPage > 0 && (
              <Button
                variant="outlined"
                onClick={handleBack}
                disabled={isSubmitting}
                leftIcon={<ChevronLeft />}
              >
                {backLabel}
              </Button>
            )}
          </div>

          <div>
            {isMultiPage && !isLastPage ? (
              <Button
                variant="primary"
                onClick={handleNext}
                disabled={isSubmitting}
                rightIcon={<ChevronRight />}
              >
                {nextLabel}
              </Button>
            ) : (
              <Button
                variant="primary"
                type="submit"
                disabled={isSubmitting}
                leftIcon={
                  isSubmitting ? <Loader2 className="animate-spin" />
                    : hasPasswordFields ? <Shield />
                    : <Send />
                }
              >
                {submitLabel}
              </Button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}
