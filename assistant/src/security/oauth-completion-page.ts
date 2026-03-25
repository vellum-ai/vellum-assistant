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

export function renderOAuthCompletionPage(
  message: string,
  success: boolean,
): string {
  const title = success ? "Authorization Successful" : "Authorization Failed";
  const color = success ? "#4CAF50" : "#f44336";
  return `<!DOCTYPE html><html><head><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f5f5f5}div{text-align:center;padding:2rem;background:white;border-radius:8px;box-shadow:0 2px 4px rgba(0,0,0,0.1)}h1{color:${color}}</style></head><body><div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div></body></html>`;
}
