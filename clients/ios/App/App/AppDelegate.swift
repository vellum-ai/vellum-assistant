import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // A QR scan that launches the terminated app delivers the connect URL
        // here as well as through `application(_:open:)`. Persist the origin
        // now, synchronously, so the bridge boots straight to it — by the time
        // the `open:` call lands, `instanceDescriptor()` may already have run.
        if let url = launchOptions?[.url] as? URL, !handleConnectDeepLink(url) {
            // Every *other* custom-scheme launch URL — a `voice` link from an
            // App Intent, the Live Activity, or Safari — is stashed as a
            // *backstop*, not as the delivery. See `launchURL` for why it is
            // both kept and deduped.
            launchURL = url
            pendingVoiceCommandURL = url
        }
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {}
    func applicationDidEnterBackground(_ application: UIApplication) {
        // Launch-URL dedupe is scoped to the launch. Re-opening the identical
        // URL later requires leaving this app first, so anything arriving after
        // a background transition is a genuinely new open, never the launch
        // URL arriving twice.
        launchURL = nil
        launchURLWasReplayed = false
    }
    func applicationWillEnterForeground(_ application: UIApplication) {}
    func applicationDidBecomeActive(_ application: UIApplication) {}
    /// A backgrounded voice session keeps the app alive (the `audio` background
    /// mode), so swiping it away in the app switcher terminates a *running*
    /// process and lands here. Its Live Activity outlives the process unless it
    /// is ended, which would strand an island the user cannot dismiss.
    func applicationWillTerminate(_ application: UIApplication) {
        VoiceLiveActivityPlugin.endRunningActivityBeforeTermination()
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        if handleConnectDeepLink(url) {
            return true
        }
        if swallowIfLaunchURLAlreadyDelivered(url) {
            return true
        }
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Universal Links — navigate the Capacitor webview to the incoming URL
        // so that deep links (e.g. ?app=X#/pr/...) open in-app instead of Safari.
        if userActivity.activityType == NSUserActivityTypeBrowsingWeb,
           let url = userActivity.webpageURL {
            navigateWebView(to: url)
        }
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

    // MARK: - APNs Token Forwarding

    func application(
      _ application: UIApplication,
      didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
      NotificationCenter.default.post(
        name: .capacitorDidRegisterForRemoteNotifications,
        object: deviceToken
      )
    }

    func application(
      _ application: UIApplication,
      didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
      NotificationCenter.default.post(
        name: .capacitorDidFailToRegisterForRemoteNotifications,
        object: error
      )
    }

    // MARK: - Self-hosted connect deep link

    /// A pair-page navigation waiting for the bridge web view to come up. Set on
    /// a cold launch (before the view controller exists) and consumed once it is
    /// ready.
    private var pendingConnectPairURL: URL?

    /// Handle `<scheme>://connect?url=<https-base>&code=<device-code>` (with an
    /// optional `name=<label>`), the custom-scheme QR path that pairs the shell
    /// to a self-hosted assistant. The `url` parameter is the server base (host,
    /// optionally with a path prefix like `/assistant-123` for Velay-style
    /// hosting); it is both persisted and the value the pair-page URL is derived
    /// from, so there is one source of truth.
    ///
    /// One handler serves both entry points: a warm open via
    /// `application(_:open:)` and a cold launch via `launchOptions[.url]`. The
    /// `connect` host distinguishes it from the OAuth-completion deep link (host
    /// `oauth-complete`), which Capacitor's `appUrlOpen` routes.
    ///
    /// The base is persisted synchronously so that on a cold launch
    /// `MyViewController.instanceDescriptor()` — which runs after this returns
    /// but before the web view loads — boots straight to it. The pair-page
    /// navigation is stashed and applied once the web view is live (immediately
    /// for a warm open; from the freshly launched view controller's
    /// `viewDidAppear` for a cold launch). Returns `true` for any `connect` link
    /// (handled or ignored) so it isn't also routed to the OAuth handler;
    /// `false` for everything else.
    private func handleConnectDeepLink(_ url: URL) -> Bool {
        guard url.host?.lowercased() == "connect" else {
            return false
        }
        guard let connect = AppDelegate.parseConnectDeepLink(url) else {
            NSLog("[connect] Ignoring malformed connect deep link")
            return true
        }

        SelfHostedServer.store(connect.base)
        SelfHostedServer.append(url: connect.base, name: connect.name)
        pendingConnectPairURL = connect.pairURL
        deliverPendingConnectNavigation()
        return true
    }

    /// Load a stashed connect pair page once the bridge web view exists. Safe to
    /// call before the view controller is created (a cold launch defers to the
    /// first `viewDidAppear`) and idempotent once the navigation is delivered.
    func deliverPendingConnectNavigation() {
        guard let pairURL = pendingConnectPairURL,
              let bridgeVC = currentBridgeViewController(),
              let webView = bridgeVC.webView
        else {
            return
        }
        pendingConnectPairURL = nil
        (bridgeVC as? MyViewController)?.bindServerTrackingToConfiguredOrigin()
        webView.load(URLRequest(url: pairURL))
    }

    /// Parse `<scheme>://connect?url=&code=` into the validated https server
    /// base, the pair-page URL to load, and the optional `name` label for the
    /// remembered-server list. Returns `nil` for a malformed or non-https link.
    ///
    /// `name` alone tolerates form encoding: a raw `+` (a space from a sender
    /// that form-encoded the query) decodes to a space, while an encoded
    /// `%2B` stays a literal plus. `url` and `code` are machine-generated and
    /// never form-encoded, so they take the strict percent decode.
    private static func parseConnectDeepLink(_ url: URL) -> (base: URL, pairURL: URL, name: String?)? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let serverParam = components.queryItems?.first(where: { $0.name == "url" })?.value,
              let code = components.queryItems?.first(where: { $0.name == "code" })?.value,
              !code.isEmpty,
              let base = SelfHostedServer.validate(serverParam),
              let pairURL = pairPageURL(forBase: base, deviceCode: code)
        else {
            return nil
        }
        let name = components.percentEncodedQueryItems?
            .first(where: { $0.name == "name" })?.value?
            .replacingOccurrences(of: "+", with: "%20")
            .removingPercentEncoding
        return (base, pairURL, name)
    }

    /// Build the standalone SPA pairing route that completes the pre-approved
    /// device-code exchange, `<base>/assistant/pair#device_code=<code>`.
    ///
    /// `/assistant/pair` is appended to the base's existing path so a hosting
    /// prefix survives (base `https://host/assistant-123` →
    /// `https://host/assistant-123/assistant/pair`); `appendingPathComponent`
    /// also normalizes a trailing slash on the base.
    private static func pairPageURL(forBase base: URL, deviceCode: String) -> URL? {
        let pairBase = base.appendingPathComponent("assistant").appendingPathComponent("pair")
        guard var components = URLComponents(url: pairBase, resolvingAgainstBaseURL: false) else {
            return nil
        }
        components.query = nil
        let encodedCode = deviceCode.addingPercentEncoding(withAllowedCharacters: .urlFragmentAllowed) ?? deviceCode
        components.percentEncodedFragment = "device_code=\(encodedCode)"
        return components.url
    }

    // MARK: - Voice command deep links

    /// A `<scheme>://voice?mode=…` command (or any other non-`connect` launch
    /// URL) waiting for the bridge web view to come up, mirroring
    /// `pendingConnectPairURL` above. Only the most recent one is kept — a
    /// superseded command is stale by definition.
    private var pendingVoiceCommandURL: URL?

    /// The URL this process was launched with (`launchOptions[.url]`), while it
    /// is still eligible to arrive a second time through
    /// `application(_:open:)`.
    ///
    /// UIKit delivers a cold-launch URL through **both** routes on a non-scene
    /// app: `launchOptions[.url]` here, *and* `application(_:open:options:)`,
    /// which "is not called if your implementations return false from both the
    /// `application(_:willFinishLaunchingWithOptions:)` and
    /// `application(_:didFinishLaunchingWithOptions:)` methods"
    /// (https://developer.apple.com/documentation/uikit/uiapplicationdelegate/application(_:open:options:)).
    /// This delegate implements only the latter and returns `true`
    /// unconditionally, so the `open:` call always comes — which is why a stock
    /// Capacitor app, whose delegate handles URLs only in `application(_:open:)`,
    /// receives `appUrlOpen` from a terminated state at all.
    ///
    /// The launch stash is kept anyway, because the `open:` route has a race of
    /// its own: `ApplicationDelegateProxy` delivers by posting
    /// `.capacitorOpenURL`, and `AppPlugin` only subscribes in its `load()`, so
    /// a URL that arrives before the bridge finishes registering plugins has no
    /// observer and is dropped. Nothing in the web layer calls
    /// `App.getLaunchUrl()`, Capacitor's usual escape hatch for exactly that.
    ///
    /// So: `open:` is the delivery, the stash is the backstop, and this holds
    /// the identity that lets whichever one loses the race stay silent.
    private var launchURL: URL?

    /// Whether the backstop replayed ``launchURL`` before `application(_:open:)`
    /// got to it, so the `open:` call that follows is recognized as the same
    /// delivery rather than a second one.
    private var launchURLWasReplayed = false

    /// Reconcile an `application(_:open:)` call against the launch URL,
    /// answering whether it is a second delivery of something the web layer
    /// already has and should be dropped here.
    ///
    /// Three cases, and only the launch URL reaches any of them:
    ///
    /// 1. The backstop already replayed it — swallow, the web layer has it.
    /// 2. The bridge is up, so this forward will be observed. Drop the backstop
    ///    and deliver here.
    /// 3. The bridge is not up yet: `ApplicationDelegateProxy` posts
    ///    `.capacitorOpenURL` to an `AppPlugin` that has not subscribed, so this
    ///    forward goes nowhere. Keep the backstop — it is the only delivery
    ///    left. The forward still happens, harmlessly, and sets the proxy's
    ///    `lastURL` for `App.getLaunchUrl()`.
    ///
    /// The bridge check is `webView != nil`, which is exactly what the replay
    /// waits for: `CAPBridgeViewController` builds the web view and registers
    /// plugins in one synchronous `viewDidLoad`, so from the outside the two are
    /// the same fact.
    private func swallowIfLaunchURLAlreadyDelivered(_ url: URL) -> Bool {
        guard url == launchURL else { return false }
        if launchURLWasReplayed {
            launchURL = nil
            launchURLWasReplayed = false
            return true
        }
        guard currentBridgeViewController()?.webView != nil else {
            return false
        }
        launchURL = nil
        pendingVoiceCommandURL = nil
        return false
    }

    /// Hand a voice command to the web layer, deferring until the bridge web
    /// view exists.
    ///
    /// Called by the App Intents (`StartVoiceModeIntent` /
    /// `StartNewVoiceConversationIntent`), which run in-process and therefore
    /// never pass through `application(_:open:)`, and by the terminated-launch
    /// path in `didFinishLaunchingWithOptions`.
    func deliverVoiceCommand(_ url: URL) {
        pendingVoiceCommandURL = url
        deliverPendingVoiceCommand()
    }

    /// Replay a stashed voice command once the bridge web view is live. Safe to
    /// call before the view controller exists (a cold launch defers to the first
    /// `viewDidAppear`) and idempotent once delivered.
    ///
    /// Delivery goes through `ApplicationDelegateProxy`, the exact channel a
    /// warm `application(_:open:)` uses, so the URL surfaces to JS as Capacitor's
    /// `appUrlOpen` and `capacitor-deep-links.ts` handles it with no new web
    /// code. `AppPlugin` posts that event with `retainUntilConsumed: true`, so a
    /// command delivered before the SPA has registered its listener is replayed
    /// rather than lost.
    ///
    /// Exactly one delivery of a launch URL, whichever route wins the race —
    /// see ``launchURL``.
    func deliverPendingVoiceCommand() {
        guard let url = pendingVoiceCommandURL,
              currentBridgeViewController()?.webView != nil
        else {
            return
        }
        pendingVoiceCommandURL = nil
        if url == launchURL {
            launchURLWasReplayed = true
        }
        _ = ApplicationDelegateProxy.shared.application(
            UIApplication.shared,
            open: url,
            options: [:]
        )
    }

    // MARK: - Web view navigation

    /// The Capacitor bridge view controller — the window root, or embedded in a
    /// navigation controller, or a direct child of the root.
    private func currentBridgeViewController() -> CAPBridgeViewController? {
        guard let rootVC = window?.rootViewController else { return nil }
        if let bridgeVC = rootVC as? CAPBridgeViewController {
            return bridgeVC
        }
        if let nav = rootVC as? UINavigationController,
           let bridgeVC = nav.viewControllers.first as? CAPBridgeViewController {
            return bridgeVC
        }
        return rootVC.children.compactMap { $0 as? CAPBridgeViewController }.first
    }

    /// Navigate the bridge's WKWebView to the given URL.
    private func navigateWebView(to url: URL) {
        currentBridgeViewController()?.webView?.load(URLRequest(url: url))
    }
}
