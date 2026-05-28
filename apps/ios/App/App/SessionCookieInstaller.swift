import Foundation
import WebKit

/// Plants the server session cookie into WKWebView's `WKHTTPCookieStore`
/// after a native auth or biometric-recovery flow returns a session token.
///
/// Lives on the native side because `document.cookie` in JS (a) cannot set
/// `HttpOnly`, (b) flushes async into WKWebView's store (race against the
/// next navigation), and (c) cannot set a `Max-Age` that the WKWebView
/// will honor across cold launches — the previous JS path produced a
/// session-only cookie that disappeared every time the app was killed.
enum SessionCookieInstaller {
    /// Two weeks. Matches the deployed backend's session lifetime.
    private static let maxAgeSeconds = 1_209_600

    static func install(
        token: String,
        server: URL,
        into webView: WKWebView,
        completion: @escaping () -> Void
    ) {
        guard let host = server.host else {
            completion()
            return
        }

        // `__Secure-` is the deployed-env cookie name; bare `sessionid`
        // is for the HTTP LAN-IP local dev loop, where the `__Secure-`
        // prefix would be rejected by the browser.
        let isSecure = server.scheme == "https"
        let name = isSecure ? "__Secure-sessionid" : "sessionid"
        let secureAttr = isSecure ? "; Secure" : ""
        let setCookie = "\(name)=\(token); Domain=\(host); Path=/; Max-Age=\(maxAgeSeconds); HttpOnly; SameSite=Lax\(secureAttr)"

        // `HTTPCookie(properties:)` rejects `HttpOnly` and `SameSite`
        // property keys, so parse a real `Set-Cookie` header instead.
        guard let cookie = HTTPCookie.cookies(
            withResponseHeaderFields: ["Set-Cookie": setCookie],
            for: server
        ).first else {
            completion()
            return
        }

        DispatchQueue.main.async {
            webView.configuration.websiteDataStore.httpCookieStore
                .setCookie(cookie, completionHandler: completion)
        }
    }
}
