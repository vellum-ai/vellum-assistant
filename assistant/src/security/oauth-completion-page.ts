/**
 * Shared HTML rendering for OAuth completion pages shown in the browser
 * after a loopback/redirect OAuth flow completes.
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatProviderName(provider: string): string {
  // Capitalize first letter of each word, handle common acronyms
  return provider
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function renderOAuthCompletionPage(
  message: string,
  success: boolean,
  provider?: string,
): string {
  const displayProvider = provider ? formatProviderName(provider) : "";
  const title = success
    ? displayProvider
      ? `Connected to ${escapeHtml(displayProvider)}`
      : "Authorization Successful"
    : "Authorization Failed";
  const subtitle = success
    ? "You can close this tab and return to your assistant."
    : escapeHtml(message);

  const checkmarkSvg = `<svg class="icon" viewBox="0 0 56 56" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="28" cy="28" r="28" fill="var(--positive-bg)"/>
      <path class="check" d="M17 28.5L24.5 36L39 21" stroke="var(--positive-fg)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    </svg>`;

  const errorSvg = `<svg class="icon" viewBox="0 0 56 56" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="28" cy="28" r="28" fill="var(--negative-bg)"/>
      <path class="cross cross-1" d="M20 20L36 36" stroke="var(--negative-fg)" stroke-width="3.5" stroke-linecap="round" fill="none"/>
      <path class="cross cross-2" d="M36 20L20 36" stroke="var(--negative-fg)" stroke-width="3.5" stroke-linecap="round" fill="none"/>
    </svg>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --surface: #F5F3EB;
      --surface-card: #FFFFFF;
      --card-border: #E8E6DA;
      --text-primary: #2A2A28;
      --text-secondary: #4A4A46;
      --text-tertiary: #A1A096;
      --positive-bg: #D4DFD0;
      --positive-fg: #516748;
      --negative-bg: #F7DAC9;
      --negative-fg: #DA491A;
      --shadow: 0 1px 3px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.06);
      --font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --surface: #1A1A18;
        --surface-card: #2A2A28;
        --card-border: #3A3A37;
        --text-primary: #F5F3EB;
        --text-secondary: #BDB9A9;
        --text-tertiary: #6B6B65;
        --positive-bg: #1A2316;
        --positive-fg: #7A8B6F;
        --negative-bg: #4E281D;
        --negative-fg: #E86B40;
        --shadow: 0 1px 3px rgba(0,0,0,0.2), 0 4px 12px rgba(0,0,0,0.3);
      }
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: var(--font);
      background: var(--surface);
      color: var(--text-primary);
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      -webkit-font-smoothing: antialiased;
    }
    .card {
      text-align: center;
      padding: 48px 40px 40px;
      background: var(--surface-card);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      box-shadow: var(--shadow);
      max-width: 380px;
      width: 100%;
      opacity: 0;
      transform: translateY(8px) scale(0.98);
      animation: cardIn 0.5s cubic-bezier(0.16, 1, 0.3, 1) 0.1s forwards;
    }
    @keyframes cardIn {
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    .icon {
      width: 56px;
      height: 56px;
      margin-bottom: 20px;
    }
    .check {
      stroke-dasharray: 32;
      stroke-dashoffset: 32;
      animation: draw 0.4s ease-out 0.45s forwards;
    }
    .cross {
      stroke-dasharray: 22;
      stroke-dashoffset: 22;
    }
    .cross-1 { animation: draw 0.3s ease-out 0.45s forwards; }
    .cross-2 { animation: draw 0.3s ease-out 0.55s forwards; }
    @keyframes draw {
      to { stroke-dashoffset: 0; }
    }
    h1 {
      font-size: 18px;
      font-weight: 600;
      letter-spacing: -0.2px;
      color: var(--text-primary);
      margin-bottom: 6px;
    }
    p {
      font-size: 13px;
      line-height: 1.5;
      color: var(--text-secondary);
    }
  </style>
</head>
<body>
  <div class="card">
    ${success ? checkmarkSvg : errorSvg}
    <h1>${escapeHtml(title)}</h1>
    <p>${subtitle}</p>
  </div>
</body>
</html>`;
}
