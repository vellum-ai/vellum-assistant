import Capacitor
import UIKit
import WebKit

/// Custom `CAPBridgeViewController` subclass used for two things:
///
/// 1. Register `NativeAuthPlugin` and `NativeBiometricPlugin` as local
///    plugin instances at bridge init time. Capacitor auto-registers
///    plugins that live in external packages via their `Package.swift`
///    manifest; these plugins live inside the App target (no SPM module
///    for ~100 lines of Swift each) so the bridge won't discover them
///    automatically — we hand them over here.
///
/// 2. Inject a `WKUserScript` at `.atDocumentStart` that pins focusable
///    fields to a minimum 16px font-size, preventing the iOS auto-zoom
///    behaviour that otherwise gets stuck after the input loses focus.
///
/// Safe-area handling lives on the web side: `apps/web/index.html` ships
/// `viewport-fit=cover` in its viewport meta tag, and `initSafeAreaBridge()`
/// in `runtime/native-safe-area.ts` reads native insets via
/// `capacitor-plugin-safe-area` and writes them to `--safe-area-inset-*`
/// CSS custom properties. `env(safe-area-inset-*)` alone returns 0 in
/// Capacitor's WKWebView (WebKit bug #191872 + Capacitor #2149), so the
/// bridge is what actually compensates for the notch and home indicator.
///
/// `Main.storyboard`'s single scene uses this class instead of the stock
/// `CAPBridgeViewController`.
class MyViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(NativeAuthPlugin())
        bridge?.registerPluginInstance(NativeBiometricPlugin())
        installInputZoomPreventionUserScript()
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
