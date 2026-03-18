import SwiftUI
@preconcurrency import WebKit
import VellumAssistantShared

/// WKWebView subclass that forwards scroll-wheel events to the enclosing
/// NSScrollView instead of consuming them internally.
///
/// By default, an active WKWebView swallows all scroll events — even when the
/// web content itself isn't scrollable — which prevents the outer chat
/// ScrollView from responding to trackpad/mouse-wheel input when the cursor
/// is over an inline video embed. Forwarding to `nextResponder` passes the
/// event up the AppKit responder chain to the enclosing NSScrollView.
private class ScrollForwardingWebView: WKWebView {
    override func scrollWheel(with event: NSEvent) {
        nextResponder?.scrollWheel(with: event)
    }
}

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
        let request = Self.makeRequest(url: url, provider: provider)
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

    static func dismantleNSView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
    }

    /// Build a WKWebView with the privacy-hardened configuration used for embeds.
    /// Factored out so policy tests can verify settings without a full SwiftUI context.
    static func makeConfiguredWebView() -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()

        let webView = ScrollForwardingWebView(frame: .zero, configuration: config)
        webView.allowsLinkPreview = false

        return webView
    }

    /// Build the initial request so tests can verify provider-specific headers.
    static func makeRequest(url: URL, provider: String) -> URLRequest {
        VideoEmbedRequestBuilder.buildRequest(url: url, provider: provider)
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

    /// URL schemes that are safe to open externally from untrusted embed content.
    private static let safeExternalSchemes: Set<String> = ["http", "https", "mailto"]

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

                if let host = navigationAction.request.url?.host?.lowercased(),
                   InlineVideoWebView.isAllowedHost(host, forProvider: provider) {
                    decisionHandler(.allow)
                } else {
                    // Silently block — unlike user-initiated navigations, programmatic
                    // requests (analytics, telemetry, CDN) shouldn't open browser tabs.
                    decisionHandler(.cancel)
                }
            default:
                // User-initiated navigation — open in the default browser instead
                Self.openExternallyIfSafe(navigationAction.request.url)
                decisionHandler(.cancel)
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            onLoadSuccess?()
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            guard !Self.isCancellationError(error) else { return }
            onLoadFailure?(error.localizedDescription)
        }

        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: Error
        ) {
            guard !Self.isCancellationError(error) else { return }
            onLoadFailure?(error.localizedDescription)
        }

        /// WebKit fires cancellation errors (NSURLErrorCancelled) for benign
        /// reasons like a load being superseded by a new request or a navigation
        /// policy cancellation. These are not real failures.
        private static func isCancellationError(_ error: Error) -> Bool {
            (error as NSError).code == NSURLErrorCancelled
        }

        // MARK: - WKUIDelegate

        /// Handle popup/new-window requests. Only open the URL externally when the
        /// user explicitly clicked a link; script-driven window.open() calls are
        /// silently blocked to prevent malicious embeds from triggering unsolicited
        /// browser navigations.
        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if navigationAction.navigationType == .linkActivated {
                Self.openExternallyIfSafe(navigationAction.request.url)
            }
            return nil
        }

        /// Open a URL in the default browser only if its scheme is safe.
        /// Blocks arbitrary URL scheme handlers (e.g. zoommtg://, itms-apps://)
        /// that untrusted embed content could try to trigger.
        private static func openExternallyIfSafe(_ url: URL?) {
            guard let url, let scheme = url.scheme?.lowercased(),
                  InlineVideoWebView.safeExternalSchemes.contains(scheme) else {
                return
            }
            NSWorkspace.shared.open(url)
        }
    }
}
