import type { ReactNode } from "react";

import "./globals.css";

/* Pre-hydration theme bootstrap. Mirrors the key precedence of the assistant
 * SPA's clients/web/public/theme-init.js (`device:theme` first, then the
 * shared `vellum_theme` key, then system preference; platform-only "velvet"
 * counts as dark) since both apps share the www.vellum.ai origin. Stamps
 * BOTH `.dark` (docs-theme.css) and `data-theme` (design-library tokens) to
 * avoid a light-mode flash for dark users. */
const themeInitScript = `
(function() {
  try {
    var theme = localStorage.getItem('device:theme') || localStorage.getItem('vellum_theme') || 'system';
    var isDark = theme === 'velvet' || theme === 'dark' || (theme === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', isDark);
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
  } catch (e) {}
})();
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="font-sans">
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        {children}
      </body>
    </html>
  );
}
