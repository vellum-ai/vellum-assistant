import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // A QR scan that launches the terminated app delivers the connect URL
        // here, not through `application(_:open:)` (which only covers warm
        // opens). Persist the origin now so the bridge boots to it.
        if let url = launchOptions?[.url] as? URL {
            _ = handleConnectDeepLink(url)
        }
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {}
    func applicationDidEnterBackground(_ application: UIApplication) {}
    func applicationWillEnterForeground(_ application: UIApplication) {}
    func applicationDidBecomeActive(_ application: UIApplication) {}
    func applicationWillTerminate(_ application: UIApplication) {}

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        if handleConnectDeepLink(url) {
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

    /// Handle `<scheme>://connect?url=<https-base>&code=<device-code>` — the
    /// custom-scheme QR path that pairs the shell to a self-hosted assistant. The
    /// `url` parameter is the server base (host, optionally with a path prefix
    /// like `/assistant-123` for Velay-style hosting); it is both persisted and
    /// the value the pair-page URL is derived from, so there is one source of
    /// truth.
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

    /// Parse `<scheme>://connect?url=&code=` into the validated https server base
    /// and the pair-page URL to load. Returns `nil` for a malformed or non-https
    /// link.
    private static func parseConnectDeepLink(_ url: URL) -> (base: URL, pairURL: URL)? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let serverParam = components.queryItems?.first(where: { $0.name == "url" })?.value,
              let code = components.queryItems?.first(where: { $0.name == "code" })?.value,
              !code.isEmpty,
              let base = SelfHostedServer.validate(serverParam),
              let pairURL = pairPageURL(forBase: base, deviceCode: code)
        else {
            return nil
        }
        return (base, pairURL)
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
