import Capacitor
import UIKit
import WebKit

/// Custom `CAPBridgeViewController` subclass used for two things:
///
/// 1. Register `NativeAuthPlugin` as a local plugin instance at bridge init
///    time. Capacitor auto-registers plugins that live in external packages
///    via their `Package.swift` manifest; `NativeAuthPlugin` lives inside
///    the App target (no SPM module for ~100 lines of Swift) so the bridge
///    won't discover it automatically — we hand it over here.
///
/// 2. Force `viewport-fit=cover` into the viewport meta tag at document
///    start, before WebKit parses the page's own `<meta>`. This is
///    required to make `env(safe-area-inset-*)` resolve to non-zero values
///    inside the WKWebView so the page's safe-area padding
///    (`<Layout>`, `<AssistantShell>`, the mobile drawer, etc.) actually
///    compensates for the notch and home indicator. The web side ships a
///    synchronous script that does the same thing, but it runs *after*
///    WebKit has already committed to `viewport-fit=auto` from the initial
///    meta tag, and dynamic viewport-meta updates do not reliably trigger
///    a safe-area-inset recomputation. Injecting at
///    `.atDocumentStart` via `WKUserScript` runs before the page's own
///    meta is parsed, so the cover behaviour is locked in from first
///    layout.
///
/// `Main.storyboard`'s single scene uses this class instead of the stock
/// `CAPBridgeViewController`.
class MyViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(NativeAuthPlugin())
        bridge?.registerPluginInstance(NativeBiometricPlugin())
        installViewportFitCoverUserScript()
        installInputZoomPreventionUserScript()
    }

    /// Inject a `WKUserScript` at `.atDocumentStart` that sets
    /// `viewport-fit=cover` on the viewport meta tag before WebKit parses
    /// the page's own `<meta>`. The web side also ships a synchronous
    /// `<script>` that does the same thing, but it runs *after* WebKit
    /// has already committed to the initial viewport — doing it here
    /// ensures cover is locked in from first layout.
    ///
    /// Note: this alone does not make `env(safe-area-inset-*)` return
    /// non-zero values inside Capacitor's WKWebView (WebKit bug #191872,
    /// plus the `contentInset: "never"` interaction documented in
    /// Capacitor issue #2149). That's why we also ship
    /// `capacitor-plugin-safe-area` + `<SafeAreaBridge>` on the web side,
    /// which reads `window.safeAreaInsets` natively and injects it as
    /// `--safe-area-inset-*` CSS custom properties. This user script is
    /// still useful because `viewport-fit=cover` is what lets the
    /// WKWebView extend its surface under the notch and home indicator
    /// in the first place.
    private func installViewportFitCoverUserScript() {
        guard let contentController = webView?.configuration.userContentController else { return }
        let source = """
        (function() {
          var ensureViewport = function() {
            if (!document.head) return;
            var meta = document.querySelector('meta[name=viewport]');
            var content = 'width=device-width, initial-scale=1, viewport-fit=cover';
            if (meta) {
              meta.setAttribute('content', content);
            } else {
              meta = document.createElement('meta');
              meta.name = 'viewport';
              meta.content = content;
              document.head.appendChild(meta);
            }
          };
          ensureViewport();
          if (document.readyState === 'loading') {
            document.addEventListener('readystatechange', ensureViewport, { once: true });
          }
        })();
        """
        let script = WKUserScript(
            source: source,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        contentController.addUserScript(script)
    }

    /// Inject a `WKUserScript` at `.atDocumentStart` that forces all
    /// `<input>`, `<textarea>`, and `<select>` elements to a minimum
    /// `font-size` of 16px. iOS Safari / WKWebView automatically zooms
    /// into any focusable field whose computed `font-size` is below 16px
    /// — and critically, once it zooms in it never resets the viewport
    /// scale, leaving the entire app view stuck at a zoomed-in level even
    /// after the user navigates away from the input.
    ///
    /// Pinning to 16px prevents the zoom from triggering in the first
    /// place. The visual difference between 14px and 16px is negligible
    /// at standard iOS display densities, and this only affects the
    /// WKWebView shell — it has no impact on regular browser sessions.
    private func installInputZoomPreventionUserScript() {
        guard let contentController = webView?.configuration.userContentController else { return }
        let source = """
        (function() {
          var style = document.createElement('style');
          style.textContent = 'input, textarea, select { font-size: max(16px, 1em) !important; }';
          if (document.head) {
            document.head.appendChild(style);
          } else {
            document.addEventListener('DOMContentLoaded', function() {
              document.head.appendChild(style);
            }, { once: true });
          }
        })();
        """
        let script = WKUserScript(
            source: source,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        contentController.addUserScript(script)
    }
}
