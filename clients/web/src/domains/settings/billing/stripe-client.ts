import { loadStripe, type Stripe } from "@stripe/stripe-js";

// Stripe publishable key, injected at build time by the deployment pipeline.
// This is Stripe's *publishable* key (pk_live_* / pk_test_*), designed to be
// embedded in client bundles: https://docs.stripe.com/keys#obtain-api-keys
// Not in .env.example because local/OSS contributors don't need billing;
// without it the modal gracefully shows <MissingStripeKeyNotice />.
export const STRIPE_PK = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY ?? "";

let stripePromise: Promise<Stripe | null> | null = null;

export function getStripePromise() {
  if (!stripePromise && STRIPE_PK) {
    stripePromise = loadStripe(STRIPE_PK);
  }
  return stripePromise;
}

/**
 * A SetupIntent client secret is `<setup intent id>_secret_<random>`, so the
 * id is everything before the `_secret` marker.
 */
export function setupIntentIdFromClientSecret(
  clientSecret: string | null,
): string | null {
  if (!clientSecret) {
    return null;
  }
  const marker = clientSecret.indexOf("_secret");
  if (marker <= 0) {
    return null;
  }
  return clientSecret.slice(0, marker);
}
