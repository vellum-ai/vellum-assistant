import { useCallback, useEffect, useState } from 'react';

import type {
  FeedbackClassification,
  FeedbackFormData,
} from '../../background/feedback.js';
import { sendMessage } from '../lib/chrome-message.js';

export interface FeedbackScreenProps {
  onBack: () => void;
}

interface ReasonOption {
  id: FeedbackClassification;
  label: string;
  hint: string;
}

const REASONS: ReadonlyArray<ReasonOption> = [
  { id: 'bug_report', label: 'Bug Report', hint: 'Something is broken or behaving unexpectedly' },
  { id: 'feature_request', label: 'Feature Request', hint: 'A capability you wish the extension had' },
  { id: 'other', label: 'Other', hint: 'Anything else worth telling us' },
];

interface SubmitFeedbackResponse {
  ok: boolean;
  error?: string;
}

/**
 * Share Feedback form mirroring the macOS `LogReportFormView`. Captures
 * a classification, contact email, message, and an opt-in diagnostic
 * bundle, then ships them to the platform via the background worker.
 */
export function FeedbackScreen({ onBack }: FeedbackScreenProps) {
  const [classification, setClassification] = useState<FeedbackClassification>('bug_report');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [status, setStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [errorText, setErrorText] = useState<string | null>(null);

  useEffect(() => {
    sendMessage<{ ok: boolean; session?: { email: string } | null }>({ type: 'get-session' }).then(
      (response) => {
        if (response?.ok && response.session?.email) {
          setEmail(response.session.email);
        }
      },
    );
  }, []);

  const handleSubmit = useCallback(async () => {
    if (status === 'submitting') return;
    if (!message.trim()) {
      setStatus('error');
      setErrorText('Please add a message describing what happened.');
      return;
    }
    if (!email.trim()) {
      setStatus('error');
      setErrorText('Please add an email so we can follow up.');
      return;
    }

    setStatus('submitting');
    setErrorText(null);

    const form: FeedbackFormData = {
      classification,
      message: message.trim(),
      email: email.trim(),
      includeDiagnostics,
    };

    const response = await sendMessage<SubmitFeedbackResponse>({
      type: 'submit-feedback',
      form,
    });

    if (response?.ok) {
      setStatus('success');
      setMessage('');
    } else {
      setStatus('error');
      setErrorText(response?.error ?? 'Could not send feedback. Please try again.');
    }
  }, [classification, email, includeDiagnostics, message, status]);

  const submitDisabled = status === 'submitting' || !message.trim() || !email.trim();

  return (
    <div className="flex flex-col gap-3">
      <header className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="flex h-7 w-7 items-center justify-center rounded-md text-fg-muted transition-colors hover:text-fg"
          aria-label="Back"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path
              d="M9 2L4 7L9 12"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <h1 className="text-[13px] font-semibold tracking-[0.01em] text-fg-muted">Share Feedback</h1>
      </header>

      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-fg-subtle">Reason</span>
        <div className="flex flex-col gap-1.5">
          {REASONS.map((option) => {
            const selected = option.id === classification;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => setClassification(option.id)}
                className={
                  'rounded-lg border px-3 py-2 text-left transition-colors ' +
                  (selected
                    ? 'border-fg bg-surface-alt'
                    : 'border-edge bg-surface hover:border-edge-hover hover:bg-surface-alt')
                }
              >
                <p className="text-[12px] font-medium text-fg">{option.label}</p>
                <p className="text-[11px] text-fg-subtle">{option.hint}</p>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="feedback-email" className="text-[11px] font-medium uppercase tracking-wide text-fg-subtle">
          Email
        </label>
        <input
          id="feedback-email"
          type="email"
          value={email}
          placeholder="you@company.com"
          onChange={(event) => setEmail(event.target.value)}
          className="rounded-lg border border-edge bg-surface px-3 py-2 text-[12px] text-fg outline-none focus:border-edge-hover"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="feedback-message" className="text-[11px] font-medium uppercase tracking-wide text-fg-subtle">
          Message
        </label>
        <textarea
          id="feedback-message"
          value={message}
          placeholder="What were you doing? What did you expect? What happened instead?"
          onChange={(event) => setMessage(event.target.value)}
          rows={5}
          className="rounded-lg border border-edge bg-surface px-3 py-2 text-[12px] text-fg outline-none focus:border-edge-hover"
        />
      </div>

      <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-edge bg-surface px-3 py-2 transition-colors hover:border-edge-hover">
        <input
          type="checkbox"
          checked={includeDiagnostics}
          onChange={(event) => setIncludeDiagnostics(event.target.checked)}
          className="mt-0.5"
        />
        <div className="flex flex-col gap-0.5">
          <span className="text-[12px] font-medium text-fg">Include diagnostic data</span>
          <span className="text-[11px] text-fg-subtle">
            Attaches recent operations, connection state, and Chrome version. No session tokens
            or auth secrets are included.
          </span>
        </div>
      </label>

      {status === 'success' && (
        <div className="rounded-lg border border-green-300 bg-green-50 px-3 py-2 text-[12px] text-green-800 dark:border-green-700 dark:bg-green-950 dark:text-green-200">
          Feedback sent. Thanks!
        </div>
      )}

      {status === 'error' && errorText && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-300">
          {errorText}
        </div>
      )}

      <button
        type="button"
        onClick={handleSubmit}
        disabled={submitDisabled}
        className={
          'mt-1 rounded-lg px-3 py-2 text-[12px] font-medium transition-colors ' +
          (submitDisabled
            ? 'cursor-not-allowed bg-surface-alt text-fg-subtle'
            : 'cursor-pointer bg-fg text-bg hover:opacity-90')
        }
      >
        {status === 'submitting' ? 'Sending…' : 'Send feedback'}
      </button>
    </div>
  );
}
