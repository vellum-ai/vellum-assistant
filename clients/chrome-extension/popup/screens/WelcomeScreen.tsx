import { useEffect, useState } from 'react';

import { useBranding } from '../hooks/use-branding.js';

export interface WelcomeScreenProps {
  onSignIn: () => void;
  onSelfHosted: () => void;
  signingIn?: boolean;
  signInError?: string | null;
}

export function WelcomeScreen({ onSignIn, onSelfHosted, signingIn, signInError }: WelcomeScreenProps) {
  const branding = useBranding();
  const [visibleError, setVisibleError] = useState<string | null>(null);

  // Show error for 4 seconds then clear
  useEffect(() => {
    if (!signInError) {
      setVisibleError(null);
      return;
    }
    setVisibleError(signInError);
    const timer = setTimeout(() => setVisibleError(null), 4000);
    return () => clearTimeout(timer);
  }, [signInError]);

  return (
    <div className="flex flex-col items-center justify-center min-h-[320px] px-4 pt-8 pb-4 text-center">
      <img
        src={branding.icons.icon128}
        alt={branding.name}
        className="w-14 h-14 mb-5 animate-fade-up"
        style={{ animationDelay: '0.1s' }}
      />

      <h1
        className="text-xl font-semibold text-fg mb-1.5 animate-fade-up"
        style={{ animationDelay: '0.25s' }}
      >
        {branding.name}
      </h1>

      <p
        className="text-sm text-fg-muted mb-7 animate-fade-up"
        style={{ animationDelay: '0.35s' }}
      >
        Connect your browser to your AI assistant
      </p>

      <div className="flex flex-col gap-2 w-full max-w-[240px]">
        <button
          type="button"
          onClick={onSignIn}
          disabled={signingIn}
          className="bg-fg text-bg rounded-lg px-4 py-2.5 text-sm font-medium w-full hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {signingIn ? 'Signing in...' : 'Sign in with Vellum'}
        </button>
        <button
          type="button"
          onClick={onSelfHosted}
          disabled={signingIn}
          className="bg-transparent text-fg-muted border border-edge rounded-lg px-4 py-2.5 text-sm w-full hover:border-edge-hover hover:text-fg transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
        >
          Connect to self-hosted
        </button>
      </div>

      {visibleError && (
        <p className="text-xs text-red-500 mt-3 max-w-[240px]">
          {visibleError}
        </p>
      )}

      <p className="text-xs text-fg-subtle mt-auto pt-4">
        &copy; 2026 Vellum Inc.
      </p>
    </div>
  );
}
