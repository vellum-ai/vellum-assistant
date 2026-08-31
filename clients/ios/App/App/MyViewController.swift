import Capacitor
import UIKit
import WebKit

/// Custom `CAPBridgeViewController` subclass that:
///
/// 1. Registers `NativeAuthPlugin`, `NativeBiometricPlugin`,
///    `VoiceAudioSessionPlugin`, `VoiceLiveActivityPlugin`,
///    `ApnsEnvironmentPlugin`, `SelfHostedServersPlugin`,
///    `RecentChatsPlugin`, `WidgetSnapshotPlugin`, and `AppIconPlugin` as
///    local plugin instances at bridge init time.
///    These plugins live inside the App target (no SPM module) so the bridge
///    won't discover them automatically.
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

    /// The way out of an origin that cannot be reached, as a route under the
    /// app entry: the baked Vellum Cloud origin serves the chooser whether or
    /// not the configured one is up, and the chooser lists every remembered
    /// origin, so the unreachable one is still one tap away once it recovers.
    /// `noAutoSkip` keeps it from connecting straight through a lone assistant.
    /// Mirrors the pairing page's cancel route.
    private static let chooserRoutePath = "select-assistant?noAutoSkip=1"

    // MARK: - Self-hosted server origin

    /// The baked Vellum Cloud URL from `capacitor.config.json`, captured before
    /// any self-hosted override is applied so a cleared preference and the
    /// unreachable alert's "Choose Assistant" fallback can always return here.
    private var bakedServerURL: URL?

    /// The baked Vellum Cloud URL as a string, exposed for the
    /// `SelfHostedServers` plugin's `list` result.
    var bakedServerURLString: String? {
        return bakedServerURL?.absoluteString
    }

    /// Retains the navigation-delegate decorator. Capacitor stores its
    /// `navigationDelegate` weakly, so the proxy must be owned here to stay
    /// alive for the view controller's lifetime.
    private var navigationDelegateProxy: NavigationDelegateProxy?

    /// The live unreachable-server alert, so a second failure for the same load
    /// does not stack another one. Weak because the presentation owns it;
    /// `disarmUnreachableAlert()` is what actually re-arms the guard, since the
    /// reference outlives the alert's dismissal.
    private weak var unreachableAlert: UIAlertController?

    /// How long to wait before re-offering the unreachable alert when a
    /// presentation is still animating out. Comfortably longer than UIKit's
    /// modal transition, and only ever reached on a failure.
    private static let alertRetryDelay: TimeInterval = 0.5

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
    ///
    /// This is also where a launch reports the origin it is applying to the
    /// widget snapshot, which is what makes the origin-change invariant on
    /// `SelfHostedServer` survive a change made against a terminated app: the
    /// iOS Settings pane can rewrite the preference with no process to observe
    /// it, and this is the first point at which the origin for this launch is
    /// known. The report happens ahead of the early return so a launch back on
    /// the baked cloud origin is recorded too.
    override open func instanceDescriptor() -> InstanceDescriptor {
        let descriptor = super.instanceDescriptor()
        bakedServerURL = descriptor.serverURL.flatMap { URL(string: $0) }

        let configured = SelfHostedServer.configuredURL()
        appliedServerURL = configured ?? bakedServerURL
        WidgetSnapshotPlugin.recordAppliedOrigin(SelfHostedServer.activeOriginIdentity())
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

    /// Paint the web view's backgrounds with the design system's
    /// `--surface-overlay` token so the safe-area regions that fall *outside*
    /// the web layout viewport, most visibly the home-indicator band below
    /// the drawer, match the web surface instead of the system default.
    ///
    /// Capacitor's `CAPBridgeViewController.loadView()` assigns
    /// `view = webView`, so there is no separate root view behind the web
    /// view: the `view.backgroundColor` and `webView?.backgroundColor` writes
    /// below alias the same layer, and all four background writes cooperate
    /// on the one web view. The web content extends under
    /// `viewport-fit=cover`, but the layout height stops at the safe-area
    /// edge; with the keyboard closed, the home-indicator band is painted by
    /// the web view's own background plus `underPageBackgroundColor` (see
    /// below), which otherwise fall back to `systemBackground` (pure white /
    /// near-black) and read as a seam against `--surface-overlay` (`#FDFDFC`
    /// light / `#1C2024` dark). While the keyboard is shown, the Keyboard
    /// plugin (`resize: native`) shrinks the web view frame, and the region
    /// below it is backed only by the `UIWindow`, whose backdrop is painted
    /// via the Keyboard plugin's `autoBackdropColor` config in
    /// `capacitor.config.ts`.
    ///
    /// Making the web view non-opaque with a matching background lets the
    /// token color show through uniformly. The color lives in the
    /// `SurfaceOverlay` asset-catalog color set (light + dark appearances) so
    /// it tracks the design token as a single native source of truth rather
    /// than a hardcoded literal.
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
        bridge?.registerPluginInstance(VoiceAudioSessionPlugin())
        bridge?.registerPluginInstance(VoiceLiveActivityPlugin())
        bridge?.registerPluginInstance(ApnsEnvironmentPlugin())
        bridge?.registerPluginInstance(SelfHostedServersPlugin())
        bridge?.registerPluginInstance(RecentChatsPlugin())
        bridge?.registerPluginInstance(WidgetSnapshotPlugin())
        bridge?.registerPluginInstance(AppIconPlugin())
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
    ///
    /// This is the running-app half of the one native origin change
    /// `SelfHostedServer.setActive` cannot see: the iOS Settings pane writes the
    /// active slot straight to `UserDefaults`. The guard below is the change
    /// predicate, so the widget snapshot recording that every other path
    /// inherits from that setter hangs off it here, leaving a foreground with no
    /// change alone. The same pane can also be used while the app is terminated,
    /// which `instanceDescriptor()` covers.
    @objc private func reloadIfConfiguredOriginChanged() {
        let destination = SelfHostedServer.configuredURL() ?? bakedServerURL
        guard let destination,
              destination.absoluteString != appliedServerURL?.absoluteString
        else {
            return
        }
        WidgetSnapshotPlugin.recordAppliedOrigin(SelfHostedServer.activeOriginIdentity())
        applyConfiguredOrigin()
    }

    /// Apply any deep link that arrived before the web view was ready. A cold
    /// launch stashes the connect pair-page navigation and any command URL in
    /// `AppDelegate`; both are delivered here, once the bridge web view is live
    /// and on screen. Connect goes first: it can swap the origin out from under
    /// the web view, and the command survives that reload because
    /// Capacitor retains `appUrlOpen` until a JS listener consumes it.
    override open func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        let appDelegate = UIApplication.shared.delegate as? AppDelegate
        appDelegate?.deliverPendingConnectNavigation()
        appDelegate?.deliverPendingCommandURL()
    }

    /// Bind foreground change detection to the currently-configured self-hosted
    /// origin so a connect deep link that switched the server out-of-band isn't
    /// re-detected as a change on the next foreground.
    func bindServerTrackingToConfiguredOrigin() {
        appliedServerURL = SelfHostedServer.configuredURL() ?? bakedServerURL
    }

    /// Load the effective server URL (the configured self-hosted origin or the
    /// baked default) and re-arm foreground change detection against it. Backs
    /// the `SelfHostedServers` plugin's `switchTo`; must run on the main queue.
    func applyConfiguredOrigin(path: String? = nil) {
        bindServerTrackingToConfiguredOrigin()
        guard let destination = appliedServerURL else {
            return
        }
        let entryURL = Self.appEntryURL(forBase: destination)
        let destinationURL = path.flatMap { Self.appRouteURL(forEntry: entryURL, path: $0) } ?? entryURL
        webView?.load(URLRequest(url: destinationURL))
    }

    /// The SPA entry point for a server base, `<base>/assistant`. The ingress
    /// redirects a bare `/` to a prefix-less `/assistant/`, which would drop a
    /// hosting prefix (base `https://host/assistant-123` → `https://host/assistant/`),
    /// so the segment is appended here instead. Mirrors `AppDelegate`'s
    /// pair-page URL; the baked cloud URL already carries the segment, so it is
    /// returned unchanged. Tracking state keeps the bare base.
    private static func appEntryURL(forBase base: URL) -> URL {
        guard base.lastPathComponent != "assistant" else {
            return base
        }
        return base.appendingPathComponent("assistant")
    }

    private static func appRouteURL(forEntry entry: URL, path: String) -> URL? {
        guard let components = URLComponents(string: path),
              components.scheme == nil,
              components.host == nil,
              !components.path.isEmpty,
              !components.path.split(separator: "/").contains(".."),
              components.fragment == nil
        else {
            return nil
        }
        var route = entry.appendingPathComponent(components.path)
        guard var routeComponents = URLComponents(url: route, resolvingAgainstBaseURL: false) else {
            return nil
        }
        routeComponents.percentEncodedQuery = components.percentEncodedQuery
        route = routeComponents.url ?? route
        return route
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
            webView?.isOpaque = false
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
    /// main document fails to load, or comes back an HTTP error. A no-op when no
    /// override is active (the baked Vellum Cloud URL keeps its existing
    /// behavior), when the failure is a programmatic cancellation (e.g. a
    /// superseding navigation), or when the failed navigation targeted anything
    /// outside the configured base.
    ///
    /// The `SelfHostedServer.contains` check matters because the shell loads
    /// other URLs into the same web view, Universal Links through
    /// `AppDelegate.navigateWebView` above all. Without it, an unrelated
    /// failure would offer to clear a valid preference. Scoping to the base
    /// rather than its host is what keeps that true for a base carrying a path
    /// prefix or a nondefault port. The configured server's own failures (boot
    /// load, foreground reload, the deferred connect pair-page load) all sit
    /// under the base and still alert.
    ///
    /// Cancelling an error response in the proxy makes WebKit report a second,
    /// `WebKitErrorDomain` failure for the same load; the alert's own liveness
    /// check collapses the pair into one alert.
    func webViewNavigationDidFail(_ error: Error) {
        guard let configured = SelfHostedServer.configuredURL() else { return }
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain, nsError.code == NSURLErrorCancelled {
            return
        }
        guard let failedURL = Self.failingURL(for: nsError),
              SelfHostedServer.contains(failedURL, base: configured)
        else {
            return
        }
        presentUnreachableAlert(for: configured)
    }

    /// The URL whose load failed, read from the navigation error. Populated on
    /// the `NSURLErrorDomain` failures the unreachable alert cares about
    /// (unreachable host, TLS, timeout) and on the synthesized HTTP-status
    /// failure, which carries the same key.
    private static func failingURL(for error: NSError) -> URL? {
        if let url = error.userInfo[NSURLErrorFailingURLErrorKey] as? URL {
            return url
        }
        if let string = error.userInfo[NSURLErrorFailingURLStringErrorKey] as? String {
            return URL(string: string)
        }
        return nil
    }

    private func presentUnreachableAlert(for origin: URL, attemptsLeft: Int = 6) {
        DispatchQueue.main.async { [weak self] in
            guard let self,
                  self.viewIfLoaded?.window != nil,
                  self.unreachableAlert == nil
            else { return }

            let presenter = self.topMostPresenter()
            // A presentation still animating out refuses a new one. Come back
            // for it rather than dropping the alert, which would strand the
            // user on the cancelled document this alert exists to explain. The
            // attempt budget only bounds a transition that never finishes;
            // a real one clears in well under one delay.
            guard presenter.presentedViewController == nil else {
                guard attemptsLeft > 0 else { return }
                DispatchQueue.main.asyncAfter(deadline: .now() + Self.alertRetryDelay) { [weak self] in
                    self?.presentUnreachableAlert(for: origin, attemptsLeft: attemptsLeft - 1)
                }
                return
            }

            let host = origin.host ?? origin.absoluteString
            let alert = UIAlertController(
                title: "Can't reach \(host)",
                message: "The assistant may be offline or unreachable from this device.",
                preferredStyle: .alert
            )
            alert.addAction(UIAlertAction(title: "Retry", style: .default) { [weak self] _ in
                guard let self else { return }
                self.disarmUnreachableAlert()
                self.appliedServerURL = origin
                self.webView?.load(URLRequest(url: Self.appEntryURL(forBase: origin)))
            })
            alert.addAction(UIAlertAction(title: "Choose Assistant", style: .default) { [weak self] _ in
                guard let self else { return }
                self.disarmUnreachableAlert()
                self.openAssistantChooser()
            })
            self.unreachableAlert = alert
            presenter.present(alert, animated: true)
        }
    }

    /// Release the alert-liveness guard as the alert goes away, so the next
    /// failure can raise a fresh one.
    ///
    /// This cannot wait for the weak reference to clear itself. An action
    /// handler runs while its alert is still dismissing, so the reference is
    /// very much alive at the moment Retry kicks off the next load, and a tunnel
    /// edge that answers another 4xx before the animation ends would have its
    /// replacement alert suppressed. The response is cancelled either way, so
    /// that would leave a blank document and no remaining recourse, which is the
    /// state this whole alert exists to prevent.
    private func disarmUnreachableAlert() {
        unreachableAlert = nil
    }

    /// Leave the unreachable origin for the chooser on the baked Vellum Cloud
    /// origin. Clearing unsets only the active slot, so the remembered list
    /// keeps the origin and the chooser offers it back once it recovers.
    private func openAssistantChooser() {
        SelfHostedServer.clear()
        applyConfiguredOrigin(path: Self.chooserRoutePath)
    }

    /// The controller to present from. The shell presents its own sheets (the
    /// camera, a share sheet) over this one, and presenting on a controller
    /// that already has a presentation is a UIKit no-op, which would leave the
    /// failure with no alert and the user with no way out.
    private func topMostPresenter() -> UIViewController {
        var presenter: UIViewController = self
        while let presented = presenter.presentedViewController, !presented.isBeingDismissed {
            presenter = presented
        }
        return presenter
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
///     shell can show a native "can't reach server" alert. That covers both a
///     navigation that fails outright and one the configured origin answers
///     with an HTTP error.
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

    /// Refuse a main document the configured self-hosted base answers with an
    /// HTTP error, and report it as a load failure. Scoped by
    /// `SelfHostedServer.contains` for the same reason the failure observer is:
    /// another path or port on the same host is not this server.
    ///
    /// A dead tunnel usually answers rather than refusing the connection: ngrok
    /// serves its own `ERR_NGROK_*` page with a 4xx, which is a perfectly good
    /// navigation as far as WebKit is concerned, so no `didFail` callback fires
    /// and the provider's page renders with no way back to the app. Cancelling
    /// keeps that page off screen, leaving the shell's own alert as the whole
    /// error state. Android reaches the same alert via `onReceivedHttpError`.
    ///
    /// Capacitor's `WebViewDelegationHandler` does not implement this callback,
    /// so nothing is forwarded; implementing it here does take the selector out
    /// of the message forwarding above, so re-check that on a Capacitor upgrade.
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        guard navigationResponse.isForMainFrame,
              let response = navigationResponse.response as? HTTPURLResponse,
              response.statusCode >= 400,
              let url = response.url,
              let configured = SelfHostedServer.configuredURL(),
              SelfHostedServer.contains(url, base: configured)
        else {
            decisionHandler(.allow)
            return
        }
        decisionHandler(.cancel)
        failureObserver?.webViewNavigationDidFail(Self.errorStatusFailure(for: url))
    }

    /// An HTTP error response as the kind of error `webViewNavigationDidFail`
    /// already reads, so both failure shapes land on one alert path.
    private static func errorStatusFailure(for url: URL) -> NSError {
        return NSError(
            domain: NSURLErrorDomain,
            code: NSURLErrorBadServerResponse,
            userInfo: [NSURLErrorFailingURLErrorKey: url]
        )
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
