import Foundation

/// Single source of truth for CSS custom-property tokens and theme-change JS
/// injected into WKWebViews (DynamicPageSurfaceView and DocumentEditorView).
public enum WebTokenInjector {

    /// Returns a `<style>` -safe CSS block that declares all `--v-*` semantic
    /// tokens under `:root`, with light-mode defaults and a
    /// `@media (prefers-color-scheme: dark)` override.
    ///
    /// Values are resolved from the canonical Figma semantic token table so the
    /// block is self-contained (no dependency on palette custom properties).
    public static func cssTokenBlock() -> String {
        """
        :root {
          --v-primary-disabled: #D4D1C1;
          --v-primary-base: #516748;
          --v-primary-hover: #657D5B;
          --v-primary-active: #7A8B6F;
          --v-surface-base: #E8E6DA;
          --v-surface-overlay: #F5F3EB;
          --v-surface-active: #D4D1C1;
          --v-surface-lift: #FFFFFF;
          --v-border-disabled: #D4D1C1;
          --v-border-base: #BDB9A9;
          --v-border-hover: #A1A096;
          --v-border-active: #7A8B6F;
          --v-content-emphasized: #20201E;
          --v-content-default: #2A2A28;
          --v-content-secondary: #4A4A46;
          --v-content-tertiary: #A1A096;
          --v-content-disabled: #BDB9A9;
          --v-content-background: #D4D1C1;
          --v-content-inset: #FFFFFF;
          --v-system-positive-strong: #516748;
          --v-system-positive-weak: #D4DFD0;
          --v-system-negative-strong: #DA491A;
          --v-system-negative-hover: #E86B40;
          --v-system-negative-weak: #F7DAC9;
          --v-system-mid-strong: #F1B21E;
          --v-system-mid-weak: #FCF3DD;
          --v-aux-white: #FFFFFF;
        }
        @media (prefers-color-scheme: dark) {
          :root {
            --v-primary-disabled: #3A3A37;
            --v-primary-base: #657D5B;
            --v-primary-hover: #516748;
            --v-primary-active: #7A8B6F;
            --v-surface-base: #2A2A28;
            --v-surface-overlay: #20201E;
            --v-surface-active: #3A3A37;
            --v-surface-lift: #000000;
            --v-border-disabled: #3A3A37;
            --v-border-base: #4A4A46;
            --v-border-hover: #6B6B65;
            --v-border-active: #7A8B6F;
            --v-content-emphasized: #F5F3EB;
            --v-content-default: #E8E6DA;
            --v-content-secondary: #BDB9A9;
            --v-content-tertiary: #A1A096;
            --v-content-disabled: #6B6B65;
            --v-content-background: #3A3A37;
            --v-content-inset: #000000;
            --v-system-positive-strong: #516748;
            --v-system-positive-weak: #1A2316;
            --v-system-negative-strong: #DA491A;
            --v-system-negative-hover: #AB3F1C;
            --v-system-negative-weak: #4E281D;
            --v-system-mid-strong: #F1B21E;
            --v-system-mid-weak: #4B3D1E;
            --v-aux-white: #FFFFFF;
          }
        }
        """
    }

    /// Returns a CSS block tuned for the document editor context.
    ///
    /// The editor uses the same semantic token contract but maps to warmer
    /// Stone-palette tones and a pure-white surface so that document content
    /// is easy to read and edit.
    public static func editorCSSTokenBlock() -> String {
        """
        :root {
          --v-surface-base: #FFFFFF;
          --v-surface-overlay: #FFFFFF;
          --v-border-base: #E7E5E4;
          --v-content-emphasized: #292524;
          --v-content-default: #292524;
          --v-content-secondary: #78716C;
          --v-content-tertiary: #97918B;
          --v-primary-base: #262624;
        }
        @media (prefers-color-scheme: dark) {
          :root {
            --v-surface-base: #262624;
            --v-surface-overlay: #2F2F2D;
            --v-border-base: #3A3A37;
            --v-content-emphasized: #F5F3EB;
            --v-content-default: #F5F3EB;
            --v-content-secondary: #A1A096;
            --v-content-tertiary: #6B6B65;
            --v-primary-base: #216C37;
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
