import SwiftUI
import WebKit

/// Isolated WKWebView wrapper for inline video embeds.
///
/// Uses an ephemeral (non-persistent) data store so no cookies, local storage,
/// or cache persist between sessions — important for privacy when embedding
/// third-party video players.
struct InlineVideoWebView: NSViewRepresentable {
    let url: URL

    func makeNSView(context: Context) -> WKWebView {
        let webView = Self.makeConfiguredWebView()
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        let request = URLRequest(url: url)
        webView.load(request)
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
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

    class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {

        // MARK: - WKNavigationDelegate

        /// Only allow programmatic/iframe loads (navigationType == .other) which cover the
        /// initial embed load and any in-player iframe navigations. All user-initiated
        /// navigations (link clicks, form submissions, etc.) are blocked and opened
        /// externally so the webview stays locked to the video player.
        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            switch navigationAction.navigationType {
            case .other:
                // Programmatic loads — initial embed request + iframe navigations
                decisionHandler(.allow)
            default:
                // User-initiated navigation — open in the default browser instead
                if let url = navigationAction.request.url {
                    NSWorkspace.shared.open(url)
                }
                decisionHandler(.cancel)
            }
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
