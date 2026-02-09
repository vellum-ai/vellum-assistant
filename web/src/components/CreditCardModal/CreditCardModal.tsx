"use client";

import {
  CardElement,
  Elements,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import { loadStripe, Stripe as StripeJs } from "@stripe/stripe-js";
import { CreditCard, Loader2, X } from "lucide-react";
import { MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

interface CreditCardModalProps {
  username: string;
  onSuccess: () => void;
  onClose: () => void;
}

let stripePromise: Promise<StripeJs | null> | null = null;

function getStripePromise(): Promise<StripeJs | null> {
  if (!stripePromise) {
    const key = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    if (!key) {
      return Promise.resolve(null);
    }
    stripePromise = loadStripe(key);
  }
  return stripePromise;
}

interface CardFormProps {
  username: string;
  onSuccess: () => void;
  onClose: () => void;
}

function CardForm({ username, onSuccess, onClose }: CardFormProps) {
  const stripe = useStripe();
  const elements = useElements();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [foreground, setForeground] = useState("");

  useEffect(() => {
    const readForeground = () =>
      getComputedStyle(document.documentElement).getPropertyValue("--foreground").trim();
    setForeground(readForeground());

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => setForeground(readForeground());
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const cardStyle = useMemo(
    () => ({
      base: {
        fontSize: "16px",
        color: foreground,
        "::placeholder": { color: foreground, opacity: "0.5" },
      },
    }),
    [foreground]
  );

  const handleSubmit = useCallback(async () => {
    if (!stripe || !elements) {
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/billing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to initialize payment setup");
      }

      const { client_secret } = await response.json();
      const cardElement = elements.getElement(CardElement);

      if (!cardElement) {
        throw new Error("Card element not found");
      }

      const { error: stripeError } = await stripe.confirmCardSetup(client_secret, {
        payment_method: { card: cardElement },
      });

      if (stripeError) {
        throw new Error(stripeError.message || "Failed to save card");
      }

      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save card");
    } finally {
      setIsSubmitting(false);
    }
  }, [stripe, elements, username, onSuccess]);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-800">
        <CardElement
          options={{
            style: cardStyle,
          }}
        />
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-950 dark:text-red-400">
          {error}
        </div>
      )}

      <div className="flex gap-3">
        <button
          onClick={onClose}
          disabled={isSubmitting}
          className="flex-1 rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={isSubmitting || !stripe}
          className="flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50"
        >
          {isSubmitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Saving...
            </>
          ) : (
            "Save Card"
          )}
        </button>
      </div>
    </div>
  );
}

export function CreditCardModal({ username, onSuccess, onClose }: CreditCardModalProps) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const [stripeLoaded, setStripeLoaded] = useState(false);
  const [stripeInstance, setStripeInstance] = useState<StripeJs | null>(null);

  useEffect(() => {
    getStripePromise().then((instance) => {
      setStripeInstance(instance);
      setStripeLoaded(true);
    });
  }, []);

  const handleBackdropClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (e.target === backdropRef.current) {
        onClose();
      }
    },
    [onClose]
  );

  return (
    <div
      ref={backdropRef}
      onClick={handleBackdropClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl dark:bg-zinc-900">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-100 dark:bg-indigo-950">
              <CreditCard className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
            </div>
            <div>
              <h2 className="font-semibold text-zinc-900 dark:text-white">
                Add Payment Method
              </h2>
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                A credit card is required to hatch an assistant
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="cursor-pointer rounded-lg p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {!stripeLoaded ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-indigo-600" />
          </div>
        ) : !stripeInstance ? (
          <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-950 dark:text-red-400">
            Stripe is not configured. Please set NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY.
          </div>
        ) : (
          <Elements stripe={stripeInstance}>
            <CardForm username={username} onSuccess={onSuccess} onClose={onClose} />
          </Elements>
        )}
      </div>
    </div>
  );
}
