import Capacitor
import UIKit
import WebKit

/// Custom `CAPBridgeViewController` subclass that:
///
/// 1. Registers `NativeAuthPlugin` and `NativeBiometricPlugin` as local
///    plugin instances at bridge init time. These plugins live inside the
///    App target (no SPM module) so the bridge won't discover them
///    automatically.
///
/// 2. Injects a `WKUserScript` at `.atDocumentStart` that pins focusable
///    fields to a minimum 16px font-size, preventing the iOS auto-zoom
///    behaviour that otherwise gets stuck after the input loses focus.
///
/// 3. Resets the WKWebView scroll view zoom scale to 1.0 after device
///    rotation completes. Capacitor's built-in zoom prevention only
///    disables the pinch gesture recognizer (via `scrollViewWillBeginZooming`),
///    which doesn't prevent programmatic zoom changes triggered by rotation.
///    The viewport meta tag (`maximum-scale=1.0`) is the primary guard;
///    this reset is a native safety net for any edge case the viewport
///    constraint doesn't cover.
///
/// Safe-area handling lives on the web side: `apps/web/index.html` ships
/// `viewport-fit=cover` in its viewport meta tag, and `initSafeAreaBridge()`
/// in `runtime/native-safe-area.ts` reads native insets via
/// `capacitor-plugin-safe-area` and writes them to `--safe-area-inset-*`
/// CSS custom properties.
///
/// `Main.storyboard`'s single scene uses this class instead of the stock
/// `CAPBridgeViewController`.
class MyViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(NativeAuthPlugin())
        bridge?.registerPluginInstance(NativeBiometricPlugin())
        installInputZoomPreventionUserScript()
    }

    // MARK: - Rotation zoom reset

    override open func viewWillTransition(
        to size: CGSize,
        with coordinator: UIViewControllerTransitionCoordinator
    ) {
        super.viewWillTransition(to: size, with: coordinator)
        coordinator.animate(alongsideTransition: nil) { [weak self] _ in
            guard let scrollView = self?.webView?.scrollView,
                  scrollView.zoomScale != 1.0 else { return }
            scrollView.setZoomScale(1.0, animated: false)
        }
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
