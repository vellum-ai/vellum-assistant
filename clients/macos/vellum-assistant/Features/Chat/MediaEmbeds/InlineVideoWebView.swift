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

    class Coordinator: NSObject, WKNavigationDelegate {
        // Navigation policy will be added in a later PR
    }
}
