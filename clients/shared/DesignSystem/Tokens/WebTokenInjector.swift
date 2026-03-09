import Foundation

/// Single source of truth for CSS custom-property tokens and theme-change JS
/// injected into WKWebViews (DynamicPageSurfaceView and DocumentEditorView).
public enum WebTokenInjector {

    /// Returns a `<style>` -safe CSS block that declares all `--v-*` semantic
    /// tokens under `:root`, with light-mode defaults and a
    /// `@media (prefers-color-scheme: dark)` override.
    ///
    /// Hex values are resolved from the Moss / Forest / Stone palettes so the
    /// block is self-contained (no dependency on palette custom properties).
    public static func cssTokenBlock() -> String {
        """
        :root {
          --v-bg: #FFFFFF;
          --v-surface: #F5F5F7;
          --v-surface-border: #D2D2D7;
          --v-text: #1D1D1F;
          --v-text-secondary: #86868B;
          --v-text-muted: #AEAEB2;
          --v-accent: #657D5B;
          --v-accent-hover: #516748;
        }
        @media (prefers-color-scheme: dark) {
          :root {
            --v-bg: #20201E;
            --v-surface: #3A3A37;
            --v-surface-border: #4A4A46;
            --v-text: #F5F3EB;
            --v-text-secondary: #A1A096;
            --v-text-muted: #6B6B65;
            --v-accent: #657D5B;
            --v-accent-hover: #516748;
          }
        }
        """
    }

    /// Returns a JS snippet that sets `window.vellum.theme.mode` to the
    /// current colour-scheme and dispatches a `vellum-theme-change`
    /// CustomEvent whenever the system appearance changes.
    public static func themeEventScript() -> String {
        """
        window.vellum.theme = {
            mode: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
        };
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function(e) {
            window.vellum.theme.mode = e.matches ? 'dark' : 'light';
            window.dispatchEvent(new CustomEvent('vellum-theme-change', { detail: window.vellum.theme }));
        });
        """
    }
}
