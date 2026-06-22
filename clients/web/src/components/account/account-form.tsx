import { type FormEvent, type InputHTMLAttributes, type ReactNode } from "react";

import { Notice } from "@vellumai/design-library";

const ARROW_ICON = (
  <svg
    width="20"
    height="20"
    viewBox="0 0 20 20"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M7.5 15L12.5 10L7.5 5"
      stroke="currentColor"
      strokeWidth="1.67"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

interface AccountFormProps {
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  error?: string | null;
  children: ReactNode;
  submitLabel: string;
  submittingLabel: string;
  isSubmitting: boolean;
  footer?: ReactNode;
}

export function AccountForm({
  onSubmit,
  error,
  children,
  submitLabel,
  submittingLabel,
  isSubmitting,
  footer,
}: AccountFormProps) {
  return (
    <>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        {error && <Notice tone="error">{error}</Notice>}

        <div className="flex flex-col gap-3">{children}</div>

        <button
          type="submit"
          disabled={isSubmitting}
          className="mt-2 inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-[var(--primary-base)] px-6 py-3 text-sm font-medium text-[var(--content-inset)] transition-colors hover:bg-[var(--primary-hover)] disabled:cursor-wait disabled:opacity-50"
        >
          {isSubmitting ? submittingLabel : submitLabel}
          {ARROW_ICON}
        </button>
      </form>

      {footer && <div className="mt-8 text-center">{footer}</div>}
    </>
  );
}

export function AccountInput(
  props: InputHTMLAttributes<HTMLInputElement>,
) {
  return (
    <input
      {...props}
      className="w-full rounded-lg border border-[var(--border-base)] bg-[var(--surface-overlay)] px-4 py-3 text-sm text-[var(--content-default)] outline-none placeholder:text-[var(--content-tertiary)] focus:border-[var(--primary-base)]/50"
    />
  );
}

export function AccountHeading({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: ReactNode;
}) {
  return (
    <div className="mb-8 text-center">
      <h1 className="mb-2 font-serif text-[2rem] font-bold italic text-[var(--content-default)]">
        {title}
      </h1>
      {subtitle && <p className="text-sm text-[var(--content-secondary)]">{subtitle}</p>}
    </div>
  );
}
