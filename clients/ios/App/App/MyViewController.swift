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
/// 2. Injects `WKUserScript`s at `.atDocumentEnd` to:
///    a) Pin focusable fields to a minimum 16px font-size, preventing the
///       iOS auto-zoom behaviour that gets stuck after the input loses focus.
///    b) Append `maximum-scale=1.0, user-scalable=no` to the viewport meta
///       tag. This is injected natively (rather than baked into `index.html`)
///       so regular mobile-browser users keep their default zoom/accessibility
///       behaviour. Only the Capacitor WKWebView shell receives the lock.
///
/// 3. Resets the WKWebView scroll view zoom scale to 1.0 after device
///    rotation completes. Capacitor's built-in zoom prevention only
///    disables the pinch gesture recognizer (via `scrollViewWillBeginZooming`),
///    which doesn't prevent programmatic zoom changes triggered by rotation.
///    The viewport `maximum-scale` constraint (item 2b) is the primary guard;
///    this reset is a native safety net for any edge case it doesn't cover.
///
/// Safe-area handling lives on the web side: `clients/web/index.html` ships
/// `viewport-fit=cover` in its viewport meta tag, and `initSafeAreaBridge()`
/// in `runtime/native-safe-area.ts` reads native insets via
/// `capacitor-plugin-safe-area` and writes them to `--safe-area-inset-*`
/// CSS custom properties.
///
/// 4. Substitutes `QuoteReplyWebView` (below) as the bridge's web view so
///    highlighting assistant message text offers a native "Reply" item in the
///    text-selection edit menu (iOS 16+), mirroring the web floating chip.
///    Eligibility is pushed by the web layer as a `{ canReply }` flag through
///    the `vellumTextSelection` script-message handler (primed on
///    `pointerdown`, kept in sync on `selectionchange`); tapping the item
///    calls back into the web bridge (`window.__vellumQuoteReplyFromSelection`)
///    which opens the reply bubble.
///    See `clients/web/src/domains/chat/hooks/use-native-quote-reply.ts`.
///
/// `Main.storyboard`'s single scene uses this class instead of the stock
/// `CAPBridgeViewController`.
class MyViewController: CAPBridgeViewController {
    /// Name of the script-message handler the web layer posts selection
    /// context to. Must match `NATIVE_SELECTION_HANDLER` on the web side.
    private static let textSelectionHandlerName = "vellumTextSelection"

    /// Substitute the quote-and-reply-aware web view subclass. This is the
    /// Capacitor-supported hook for providing a custom `WKWebView` class.
    override open func webView(
        with frame: CGRect,
        configuration: WKWebViewConfiguration
    ) -> WKWebView {
        return QuoteReplyWebView(frame: frame, configuration: configuration)
    }

    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(NativeAuthPlugin())
        bridge?.registerPluginInstance(NativeBiometricPlugin())
        installInputZoomPreventionUserScript()
        installViewportZoomLockUserScript()
        installTextSelectionHandler()
        installQuoteReplyCapabilityMarker()
    }

    // MARK: - Quote-and-reply edit menu

    /// Advertise to the web layer that this shell hosts the quote-and-reply
    /// action in the OS text-selection menu, so the web floating chip can
    /// suppress itself. Injected only on OS versions where `buildMenu` can add
    /// the item; the web bundle is loaded live, so older App Store installs
    /// (and unsupported OS versions) omit the marker and keep the web chip.
    private func installQuoteReplyCapabilityMarker() {
        guard #available(iOS 16.0, *),
              let contentController = webView?.configuration.userContentController
        else { return }
        let script = WKUserScript(
            source: "window.__vellumNativeQuoteReplyMenu = true;",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        contentController.addUserScript(script)
    }

    /// Register the script-message handler the web layer posts `{ canReply }`
    /// to. A weak proxy breaks the retain cycle that a direct `add(self:)`
    /// would create (contentController strongly retains its handlers).
    private func installTextSelectionHandler() {
        guard let contentController = webView?.configuration.userContentController
        else { return }
        contentController.add(
            WeakScriptMessageHandler(self),
            name: Self.textSelectionHandlerName
        )
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

    /// Pin focusable fields to a minimum 16px font-size so iOS WKWebView
    /// doesn't auto-zoom into inputs with small text.
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

    /// Append `maximum-scale=1.0, user-scalable=no` to the existing viewport
    /// meta tag so WKWebView cannot zoom beyond 1x. Injected natively rather
    /// than baked into `index.html` so regular mobile-browser users retain
    /// their default zoom/accessibility behaviour.
    private func installViewportZoomLockUserScript() {
        guard let contentController = webView?.configuration.userContentController else { return }
        let source = """
        (function() {
          var viewport = document.querySelector('meta[name="viewport"]');
          if (viewport) {
            var content = viewport.getAttribute('content') || '';
            if (content.indexOf('maximum-scale') === -1) {
              viewport.setAttribute('content', content + ', maximum-scale=1.0, user-scalable=no');
            }
          }
        })();
        """
        let script = WKUserScript(
            source: source,
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        )
        contentController.addUserScript(script)
    }
}

// MARK: - WKScriptMessageHandler

extension MyViewController: WKScriptMessageHandler {
    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard message.name == Self.textSelectionHandlerName,
              let body = message.body as? [String: Any],
              let canReply = body["canReply"] as? Bool
        else { return }
        (webView as? QuoteReplyWebView)?.canQuoteReply = canReply
    }
}

// MARK: - QuoteReplyWebView

/// `WKWebView` subclass that hosts the "Reply" text-selection edit-menu item.
///
/// The item MUST live on the web view itself — not on the containing view
/// controller. WebKit's internal first responder (`WKContentView`) forwards
/// UIKit's action validation (`canPerformAction(_:withSender:)` and
/// `targetForAction(_:withSender:)`) directly to the `WKWebView` instance
/// rather than letting it bubble up the responder chain (see
/// `WKContentViewInteraction.mm`), so a selector-based command hung off the
/// view controller is stripped from the edit menu before the view
/// controller's overrides are ever consulted. A block-based `UIAction`
/// sidesteps action validation entirely: its visibility is decided solely by
/// whether `buildMenu(with:)` inserts it, and UIKit rebuilds the edit menu
/// through `buildMenu` on every presentation, so the `canQuoteReply` flag —
/// primed by the web layer on `pointerdown`, before the long-press builds the
/// menu — is always current by the time it is read here.
final class QuoteReplyWebView: WKWebView {
    /// Identifier for the injected "Reply" edit-menu group.
    private static let quoteReplyMenuIdentifier = UIMenu.Identifier(
        "ai.vellum.assistant.quoteReply"
    )

    /// Whether the current (or imminent) web selection is inside an assistant
    /// message and therefore eligible for quote-and-reply. Pushed by the web
    /// layer via the `vellumTextSelection` script-message handler.
    var canQuoteReply = false

    override func buildMenu(with builder: UIMenuBuilder) {
        super.buildMenu(with: builder)
        guard #available(iOS 16.0, *), canQuoteReply else { return }
        let replyAction = UIAction(title: "Reply") { [weak self] _ in
            self?.evaluateJavaScript(
                "window.__vellumQuoteReplyFromSelection && window.__vellumQuoteReplyFromSelection()"
            )
        }
        let replyMenu = UIMenu(
            title: "",
            identifier: Self.quoteReplyMenuIdentifier,
            options: .displayInline,
            children: [replyAction]
        )
        // Insert before the standard Cut/Copy/Paste group so "Reply" is the
        // leading item, matching the reference selection-menu placement.
        builder.insertSibling(replyMenu, beforeMenu: .standardEdit)
    }
}

/// Weakly forwards `WKScriptMessageHandler` callbacks so a view controller can
/// register itself as a message handler without the retain cycle that
/// `WKUserContentController`'s strong reference to its handlers would otherwise
/// create.
private final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    private weak var delegate: WKScriptMessageHandler?

    init(_ delegate: WKScriptMessageHandler) {
        self.delegate = delegate
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        delegate?.userContentController(userContentController, didReceive: message)
    }
}
