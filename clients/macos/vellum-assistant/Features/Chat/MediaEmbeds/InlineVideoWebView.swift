import SwiftUI
import WebKit

/// Isolated WKWebView wrapper for inline video embeds.
///
/// Uses an ephemeral (non-persistent) data store so no cookies, local storage,
/// or cache persist between sessions — important for privacy when embedding
/// third-party video players.
struct InlineVideoWebView: NSViewRepresentable {
    let url: URL
    let provider: String

    /// Called when the webview finishes loading successfully.
    var onLoadSuccess: (() -> Void)?
    /// Called when the webview fails to load, with a human-readable error message.
    var onLoadFailure: ((String) -> Void)?

    /// Host patterns allowed for programmatic navigations, keyed by provider.
    /// Exact strings match literally; entries starting with `*.` match any
    /// subdomain via `hasSuffix` (e.g. `*.googlevideo.com` matches
    /// `r4---sn.googlevideo.com`).
    static let allowedHostsByProvider: [String: [String]] = [
        "youtube": [
            "youtube.com",
            "www.youtube.com",
            "*.googlevideo.com",
            "*.youtube.com",
            "*.ytimg.com",
            "*.google.com",
            "*.gstatic.com",
            "accounts.google.com",
        ],
        "vimeo": [
            "*.vimeo.com",
            "*.vimeocdn.com",
            "player.vimeo.com",
            "*.akamaized.net",
        ],
        "loom": [
            "*.loom.com",
            "*.loomcdn.com",
            "cdn.loom.com",
        ],
    ]

    func makeNSView(context: Context) -> WKWebView {
        let webView = Self.makeConfiguredWebView()
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        let request = URLRequest(url: url)
        webView.load(request)
        return webView
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(
            provider: provider,
            onLoadSuccess: onLoadSuccess,
            onLoadFailure: onLoadFailure
        )
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        // Keep coordinator callbacks in sync with the latest SwiftUI closures,
        // since SwiftUI may recreate the struct (and its closures) without
        // recreating the coordinator.
        context.coordinator.onLoadSuccess = onLoadSuccess
        context.coordinator.onLoadFailure = onLoadFailure
    }

    /// Build a WKWebView with the privacy-hardened configuration used for embeds.
    /// Factored out so policy tests can verify settings without a full SwiftUI context.
    static func makeConfiguredWebView() -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.allowsLinkPreview = false

        return webView
    }

    /// Check whether `host` matches any of the allowed patterns for `provider`.
    static func isAllowedHost(_ host: String, forProvider provider: String) -> Bool {
        guard let patterns = allowedHostsByProvider[provider] else {
            return false
        }
        for pattern in patterns {
            if pattern.hasPrefix("*.") {
                let suffix = String(pattern.dropFirst(1)) // e.g. ".googlevideo.com"
                if host == String(pattern.dropFirst(2)) || host.hasSuffix(suffix) {
                    return true
                }
            } else if host == pattern {
                return true
            }
        }
        return false
    }

    class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        let provider: String
        var onLoadSuccess: (() -> Void)?
        var onLoadFailure: ((String) -> Void)?
        /// The first programmatic navigation is the embed URL we control — always allow it.
        private var hasLoadedInitial = false

        init(
            provider: String,
            onLoadSuccess: (() -> Void)? = nil,
            onLoadFailure: ((String) -> Void)? = nil
        ) {
            self.provider = provider
            self.onLoadSuccess = onLoadSuccess
            self.onLoadFailure = onLoadFailure
            super.init()
        }

        // MARK: - WKNavigationDelegate

        /// Only allow programmatic/iframe loads (navigationType == .other) whose host
        /// belongs to the active provider's allowlist. The initial embed load is always
        /// permitted since we construct that URL ourselves. All user-initiated
        /// navigations (link clicks, form submissions, etc.) are blocked and opened
        /// externally so the webview stays locked to the video player.
        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            switch navigationAction.navigationType {
            case .other:
                if !hasLoadedInitial {
                    hasLoadedInitial = true
                    decisionHandler(.allow)
                    return
                }

                if let host = navigationAction.request.url?.host,
                   InlineVideoWebView.isAllowedHost(host, forProvider: provider) {
                    decisionHandler(.allow)
                } else {
                    // Subresource from an unknown domain — block it and open externally
                    // so the user can still reach it if they need to.
                    if let url = navigationAction.request.url {
                        NSWorkspace.shared.open(url)
                    }
                    decisionHandler(.cancel)
                }
            default:
                // User-initiated navigation — open in the default browser instead
                if let url = navigationAction.request.url {
                    NSWorkspace.shared.open(url)
                }
                decisionHandler(.cancel)
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            onLoadSuccess?()
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            onLoadFailure?(error.localizedDescription)
        }

        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: Error
        ) {
            onLoadFailure?(error.localizedDescription)
        }

        // MARK: - WKUIDelegate

        /// Block all popup windows by returning nil.
        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            nil
        }
    }
}
