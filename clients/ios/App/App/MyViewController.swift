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
    private static let surfaceOverlayHandlerName = "vellumSurfaceOverlay"

    // MARK: - Self-hosted server origin

    /// The baked Vellum Cloud URL from `capacitor.config.json`, captured before
    /// any self-hosted override is applied so a cleared preference and the "Use
    /// Vellum Cloud" fallback can always return here.
    private var bakedServerURL: URL?

    /// Retains the navigation-delegate decorator. Capacitor stores its
    /// `navigationDelegate` weakly, so the proxy must be owned here to stay
    /// alive for the view controller's lifetime.
    private var navigationDelegateProxy: NavigationDelegateProxy?

    /// The full server URL the web view was last loaded against — the effective
    /// self-hosted override or the baked default. Foreground change detection
    /// compares the current preference against this to decide whether to reload,
    /// so a change that keeps the same host but a different path (e.g.
    /// `https://host/a` → `https://host/b`) is still caught.
    private var appliedServerURL: URL?

    /// Point the shell at the user's self-hosted assistant when
    /// `self_hosted_server_url` is set, otherwise keep the baked Vellum Cloud
    /// URL untouched. The configured host is added to the navigation allowlist —
    /// scoped to exactly the baked cloud host plus the configured origin, never a
    /// wildcard — so its pages load as the main document instead of being handed
    /// off to Safari.
    override open func instanceDescriptor() -> InstanceDescriptor {
        let descriptor = super.instanceDescriptor()
        bakedServerURL = descriptor.serverURL.flatMap { URL(string: $0) }

        let configured = SelfHostedServer.configuredURL()
        appliedServerURL = configured ?? bakedServerURL
        guard let configured else {
            return descriptor
        }
        descriptor.serverURL = configured.absoluteString

        var allowed = descriptor.allowedNavigationHostnames
        for host in [bakedServerURL?.host, configured.host].compactMap({ $0 }) where !allowed.contains(host) {
            allowed.append(host)
        }
        descriptor.allowedNavigationHostnames = allowed

        return descriptor
    }

    /// Substitute the quote-and-reply-aware web view subclass. This is the
    /// Capacitor-supported hook for providing a custom `WKWebView` class.
    override open func webView(
        with frame: CGRect,
        configuration: WKWebViewConfiguration
    ) -> WKWebView {
        return QuoteReplyWebView(frame: frame, configuration: configuration)
    }

    /// Paint the native root view (and the web view's own backgrounds) with the
    /// design system's `--surface-overlay` token so the safe-area regions that
    /// fall *outside* the web viewport — most visibly the home-indicator band
    /// below the drawer — match the web surface instead of the system default.
    ///
    /// The WKWebView's content extends to `viewport-fit=cover`, but its layout
    /// height stops at the safe-area edge; the strip beneath it is painted by
    /// the view controller's root view, which otherwise falls back to
    /// `systemBackground` (pure white / near-black) and reads as a seam against
    /// `--surface-overlay` (`#FDFDFC` light / `#1C2024` dark). Making the web
    /// view non-opaque with a matching background lets the token color show
    /// through uniformly. The color lives in the `SurfaceOverlay` asset-catalog
    /// color set (light + dark appearances) so it tracks the design token as a
    /// single native source of truth rather than a hardcoded literal.
    override open func viewDidLoad() {
        super.viewDidLoad()
        let surfaceOverlay = UIColor(named: "SurfaceOverlay")
        view.backgroundColor = surfaceOverlay
        webView?.isOpaque = false
        webView?.backgroundColor = surfaceOverlay
        webView?.scrollView.backgroundColor = surfaceOverlay
        // WebKit paints a `WKColorExtensionView` ABOVE the web content at
        // obscured-inset edges (e.g. the home-indicator zone), colored by
        // `underPageBackgroundColor` — which defaults to `systemBackground`
        // (#FFFFFF light). None of the view/webView/scrollView backgrounds
        // above can cover it, so it must be painted explicitly or a white
        // band shows at the bottom edge in light mode on device.
        if let surfaceOverlay {
            webView?.underPageBackgroundColor = surfaceOverlay
        }

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(reloadIfConfiguredOriginChanged),
            name: UIApplication.willEnterForegroundNotification,
            object: nil
        )
    }

    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(NativeAuthPlugin())
        bridge?.registerPluginInstance(NativeBiometricPlugin())
        installNavigationDelegateProxy()
        installInputZoomPreventionUserScript()
        installViewportZoomLockUserScript()
        installTextSelectionHandler()
        installSurfaceOverlayThemeSync()
        installQuoteReplyCapabilityMarker()
    }

    // MARK: - Self-hosted origin navigation

    /// Decorate Capacitor's navigation delegate so the shell can allow top-level
    /// navigation to the user-configured self-hosted host and surface a native
    /// alert when that origin can't be reached. Every other callback is
    /// forwarded to Capacitor unchanged. A no-op when the cast fails, leaving the
    /// stock Capacitor behavior in place.
    private func installNavigationDelegateProxy() {
        guard let capacitorDelegate = webView?.navigationDelegate as? WebViewDelegationHandler else {
            return
        }
        let proxy = NavigationDelegateProxy(forwardingTo: capacitorDelegate, failureObserver: self)
        navigationDelegateProxy = proxy
        webView?.navigationDelegate = proxy
    }

    /// On return to the foreground, reload the web view if the effective server
    /// URL (self-hosted override or baked default) no longer matches what was
    /// last applied. Comparing the full URL — not just the origin — catches a
    /// same-host path change. A full reload is sufficient; the assistant has no
    /// useful offline state.
    @objc private func reloadIfConfiguredOriginChanged() {
        let destination = SelfHostedServer.configuredURL() ?? bakedServerURL
        guard let destination else { return }
        guard destination.absoluteString != appliedServerURL?.absoluteString else {
            return
        }
        appliedServerURL = destination
        webView?.load(URLRequest(url: destination))
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

    /// Keep the native safe-area backdrop in sync with the *effective web theme*
    /// rather than the OS appearance. The web UI's theme is an in-app preference
    /// (light / dark / velvet) chosen independently of iOS Dark Mode, so a static
    /// `UIColor(named:)` — which resolves against the system trait collection —
    /// paints the wrong token whenever the two disagree (e.g. app set to Light
    /// while iOS is Dark), and never matches `velvet` at all. Instead the web
    /// layer reports its computed `--surface-overlay` value on load and whenever
    /// `data-theme`, `class`, or inline `style` (workspace themes write the
    /// token via `element.style.setProperty`) changes, and native paints that. The `SurfaceOverlay`
    /// asset catalog color remains the first-paint fallback until the first
    /// message arrives, avoiding a flash.
    private func installSurfaceOverlayThemeSync() {
        guard let contentController = webView?.configuration.userContentController
        else { return }
        contentController.add(
            WeakScriptMessageHandler(self),
            name: Self.surfaceOverlayHandlerName
        )
        let source = """
        (function() {
          function report() {
            try {
              var c = getComputedStyle(document.documentElement)
                .getPropertyValue('--surface-overlay').trim();
              if (c) {
                window.webkit.messageHandlers.\(Self.surfaceOverlayHandlerName)
                  .postMessage({ color: c });
              }
            } catch (e) {}
          }
          report();
          try {
            new MutationObserver(report).observe(document.documentElement, {
              attributes: true, attributeFilter: ['data-theme', 'class', 'style'],
            });
          } catch (e) {}
        })();
        """
        let script = WKUserScript(
            source: source,
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        )
        contentController.addUserScript(script)
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
        if message.name == Self.surfaceOverlayHandlerName {
            guard let body = message.body as? [String: Any],
                  let hex = body["color"] as? String,
                  let color = UIColor(cssHex: hex)
            else { return }
            view.backgroundColor = color
            webView?.backgroundColor = color
            webView?.scrollView.backgroundColor = color
            webView?.underPageBackgroundColor = color
            return
        }
        guard message.name == Self.textSelectionHandlerName,
              let body = message.body as? [String: Any],
              let canReply = body["canReply"] as? Bool
        else { return }
        (webView as? QuoteReplyWebView)?.canQuoteReply = canReply
    }
}

// MARK: - Unreachable self-hosted origin alert

extension MyViewController: WebViewNavigationFailureObserver {
    /// Present a single native alert when the configured self-hosted server's
    /// main document fails to load. A no-op when no override is active (the baked
    /// Vellum Cloud URL keeps its existing behavior), when the failure is a
    /// programmatic cancellation (e.g. a superseding navigation), or when the
    /// failed navigation targeted some other host.
    ///
    /// The host check matters because the shell loads other URLs into the same
    /// web view — most notably Universal Links via `AppDelegate.navigateWebView`.
    /// Without it, an unrelated failure would offer to clear a valid preference.
    /// The configured server's own failures (boot load, foreground reload, the
    /// deferred connect pair-page load — all to the configured host) still alert.
    func webViewNavigationDidFail(_ error: Error) {
        guard let configured = SelfHostedServer.configuredURL() else { return }
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain, nsError.code == NSURLErrorCancelled {
            return
        }
        guard let failedHost = Self.failingURL(for: nsError)?.host?.lowercased(),
              failedHost == configured.host?.lowercased()
        else {
            return
        }
        presentUnreachableAlert(for: configured)
    }

    /// The URL whose load failed, read from the navigation error. Populated on
    /// the `NSURLErrorDomain` failures the unreachable alert cares about
    /// (unreachable host, TLS, timeout).
    private static func failingURL(for error: NSError) -> URL? {
        if let url = error.userInfo[NSURLErrorFailingURLErrorKey] as? URL {
            return url
        }
        if let string = error.userInfo[NSURLErrorFailingURLStringErrorKey] as? String {
            return URL(string: string)
        }
        return nil
    }

    private func presentUnreachableAlert(for origin: URL) {
        DispatchQueue.main.async { [weak self] in
            guard let self,
                  self.viewIfLoaded?.window != nil,
                  self.presentedViewController == nil
            else { return }

            let host = origin.host ?? origin.absoluteString
            let alert = UIAlertController(
                title: nil,
                message: "Can't reach \(host).",
                preferredStyle: .alert
            )
            alert.addAction(UIAlertAction(title: "Retry", style: .default) { [weak self] _ in
                self?.appliedServerURL = origin
                self?.webView?.load(URLRequest(url: origin))
            })
            alert.addAction(UIAlertAction(title: "Use Vellum Cloud", style: .default) { [weak self] _ in
                SelfHostedServer.clear()
                if let baked = self?.bakedServerURL {
                    self?.appliedServerURL = baked
                    self?.webView?.load(URLRequest(url: baked))
                }
            })
            self.present(alert, animated: true)
        }
    }
}

// MARK: - Navigation delegate decoration

/// Receives main-document load failures observed by `NavigationDelegateProxy`.
protocol WebViewNavigationFailureObserver: AnyObject {
    func webViewNavigationDidFail(_ error: Error)
}

/// `WKNavigationDelegate` decorator installed over Capacitor's own delegate.
///
/// Capacitor's `WebViewDelegationHandler` drives SSE handling, cookie sync, and
/// the allow-navigation policy, so it must keep receiving every callback. This
/// proxy forwards everything to it through Objective-C message forwarding and
/// only adds two behaviors:
///
///  1. Top-level navigation to the user-configured self-hosted host is allowed
///     even though Capacitor freezes its navigation allowlist at launch. This is
///     what lets a runtime origin switch (a Settings change or a connect deep
///     link) load in-app instead of being handed to Safari. The scope is exactly
///     the currently-configured host; everything else defers to Capacitor.
///  2. Main-document load failures are reported to `failureObserver` so the
///     shell can show a native "can't reach server" alert.
final class NavigationDelegateProxy: NSObject, WKNavigationDelegate {
    private weak var target: WebViewDelegationHandler?
    private weak var failureObserver: WebViewNavigationFailureObserver?

    init(forwardingTo target: WebViewDelegationHandler, failureObserver: WebViewNavigationFailureObserver) {
        self.target = target
        self.failureObserver = failureObserver
    }

    // Forward any selector this proxy doesn't implement to Capacitor's delegate
    // so every callback it relies on still reaches it unchanged.
    override func responds(to aSelector: Selector!) -> Bool {
        return super.responds(to: aSelector) || (target?.responds(to: aSelector) ?? false)
    }

    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        if target?.responds(to: aSelector) == true {
            return target
        }
        return super.forwardingTarget(for: aSelector)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        if let host = navigationAction.request.url?.host?.lowercased(),
           host == SelfHostedServer.configuredURL()?.host?.lowercased(),
           navigationAction.targetFrame?.isMainFrame ?? true {
            decisionHandler(.allow)
            return
        }
        guard let target else {
            decisionHandler(.allow)
            return
        }
        target.webView(webView, decidePolicyFor: navigationAction, decisionHandler: decisionHandler)
    }

    // The force unwrap is part of the WKNavigationDelegate declaration.
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        failureObserver?.webViewNavigationDidFail(error)
        target?.webView(webView, didFailProvisionalNavigation: navigation, withError: error)
    }

    // The force unwrap is part of the WKNavigationDelegate declaration.
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        failureObserver?.webViewNavigationDidFail(error)
        target?.webView(webView, didFail: navigation, withError: error)
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

// MARK: - CSS hex color parsing

extension UIColor {
    /// Parse a CSS hex color string (`#RGB`, `#RRGGBB`, or `#RRGGBBAA`) as
    /// reported by `getComputedStyle().getPropertyValue()` for the web theme's
    /// `--surface-overlay` token. Returns `nil` for any unrecognised format so
    /// the caller can fall back to the asset-catalog color.
    convenience init?(cssHex: String) {
        var s = cssHex.trimmingCharacters(in: .whitespacesAndNewlines)
        guard s.hasPrefix("#") else { return nil }
        s.removeFirst()
        if s.count == 3 {
            s = s.map { "\($0)\($0)" }.joined()
        }
        guard s.count == 6 || s.count == 8,
              let value = UInt64(s, radix: 16)
        else { return nil }
        let r, g, b, a: CGFloat
        if s.count == 8 {
            r = CGFloat((value & 0xFF00_0000) >> 24) / 255
            g = CGFloat((value & 0x00FF_0000) >> 16) / 255
            b = CGFloat((value & 0x0000_FF00) >> 8) / 255
            a = CGFloat(value & 0x0000_00FF) / 255
        } else {
            r = CGFloat((value & 0xFF0000) >> 16) / 255
            g = CGFloat((value & 0x00FF00) >> 8) / 255
            b = CGFloat(value & 0x0000FF) / 255
            a = 1
        }
        self.init(red: r, green: g, blue: b, alpha: a)
    }
}
