import type { ReactNode } from "react";

import "./globals.css";
// TODO(docs-app-phase-1 PR 5): move this import into the docs layout once it
// exists; imported here temporarily so the placeholder page exercises it.
import "./docs/docs-theme.css";

/* Pre-hydration port of the platform themeInitScript contract: reads the
 * shared `vellum_theme` key (platform-only "velvet" counts as dark) and stamps
 * BOTH `.dark` (docs-theme.css) and `data-theme` (design-library tokens) to
 * avoid a light-mode flash for dark users. */
const themeInitScript = `
(function() {
  try {
    var theme = localStorage.getItem('vellum_theme') || 'system';
    var isDark = theme === 'velvet' || theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
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
