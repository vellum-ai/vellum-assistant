import Foundation

/// The provenance marker that lets the web layer tell an App Intent's command
/// URL from an identical URL opened by any other app or web page.
///
/// A custom URL scheme carries no caller identity: `<scheme>://voice?prompt=…`
/// or `<scheme>://thread/<id>?message=…` looks the same whether Siri produced
/// it or a hostile page did. The web layer therefore treats every deep-linked
/// prompt as untrusted text and stages it in the composer rather than sending
/// it (see `useGlobalDeepLinkConsumer`). Intents deserve better: they run on
/// the user's own explicit action, and their reporters asked for a hands-off
/// send (LUM-3229, LUM-3230).
///
/// The shell can prove the difference mechanically. Intent URLs are produced
/// in-process and handed to `AppDelegate.deliverCommandURL(_:)`; they never
/// pass through `application(_:open:)`. External opens arrive *only* through
/// `application(_:open:options:)` and `launchOptions[.url]`. So a query item
/// that `deliverCommandURL` adds and those two entry points strip is
/// unforgeable from outside the process: by the time any URL reaches the
/// shared delivery seam (`ApplicationDelegateProxy` → Capacitor `appUrlOpen`),
/// the marker is present exactly when an intent produced it (LUM-3281).
///
/// Two paths look like a third way in and are not. A `vellum-assistant://`
/// navigation started by *web content inside the WebView* reaches Capacitor's
/// `WebViewDelegationHandler.webView(_:decidePolicyFor:)` (our
/// `NavigationDelegateProxy` forwards anything off the self-hosted origin to
/// it), which cancels the load and calls `UIApplication.shared.open(_:)`; iOS
/// routes an open of our own scheme back through `application(_:open:)`, so
/// it is stripped like any external open. And an intent that launches a
/// terminated app runs its `perform()` in-process after launch, so its URL is
/// built after `launchOptions` and can never appear there. Nothing in this
/// app or in Capacitor posts `.capacitorOpenURL` except via the proxy path
/// the delegate feeds.
///
/// The marker rides the existing URL rather than a second command channel so
/// the "one URL, one parser" contract in `NATIVE_VOICE.md` holds, and it is
/// added by the delegate rather than by the producers so the whole trust
/// boundary lives in one file and a producer cannot forget it. The Live
/// Activity's `widgetURL` (a system open that lands in `application(_:open:)`)
/// and Safari test links therefore never carry it, which is the point.
enum CommandURLProvenance {
    /// Query item name shared with `COMMAND_URL_PROVENANCE_PARAM` on the web
    /// side (`native-deep-link.ts`).
    static let queryName = "src"
    /// The one value the web side honors.
    static let intentValue = "intent"

    /// `url` with the marker added, for URLs the delegate received in-process.
    /// Idempotent: an already-marked URL is returned with a single marker.
    static func marked(_ url: URL) -> URL {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return url
        }
        var items = (components.percentEncodedQueryItems ?? []).filter { $0.name != queryName }
        items.append(URLQueryItem(name: queryName, value: intentValue))
        components.percentEncodedQueryItems = items
        return components.url ?? url
    }

    /// `url` with any marker removed, for URLs that arrived from outside the
    /// process. Everything else in the URL is preserved byte-for-byte via
    /// `percentEncodedQueryItems`, so a `message` or `prompt` value is not
    /// re-encoded and the cold-launch dedupe (`AppDelegate.launchURL`, which
    /// compares URLs by equality) keeps working as long as both deliveries
    /// are stripped before they are stored or compared.
    static func stripped(_ url: URL) -> URL {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let items = components.percentEncodedQueryItems,
              items.contains(where: { $0.name == queryName })
        else {
            return url
        }
        NSLog("[deeplink] Stripping a provenance marker from an externally opened URL")
        let remaining = items.filter { $0.name != queryName }
        components.percentEncodedQueryItems = remaining.isEmpty ? nil : remaining
        return components.url ?? url
    }
}
