import SwiftUI
@preconcurrency import WebKit
import VellumAssistantShared

/// A native WKWebView overlay for viewing external URLs in-app.
/// Used for URLs that block iframe embedding (e.g. GitHub's X-Frame-Options).
struct InAppBrowserView: View {
    let url: URL
    let onClose: () -> Void
    let onOpenExternal: (URL) -> Void

    @State private var title: String = ""
    @State private var isLoading = true

    var body: some View {
        VStack(spacing: 0) {
            // Top bar
            HStack(spacing: VSpacing.sm) {
                VButton(label: "Back", icon: VIcon.arrowLeft.rawValue, style: .outlined, iconSize: 28) {
                    onClose()
                }

                Text(title.isEmpty ? url.host ?? url.absoluteString : title)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentSecondary)
                    .lineLimit(1)
                    .truncationMode(.middle)

                Spacer(minLength: 0)

                if isLoading {
                    ProgressView()
                        .controlSize(.small)
                }

                VButton(label: "Open in browser", icon: VIcon.externalLink.rawValue, style: .outlined, iconSize: 28) {
                    onOpenExternal(url)
                }
            }
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.sm)
            .background(VColor.bgSecondary)

            Divider()

            // WKWebView
            InAppWebView(url: url, title: $title, isLoading: $isLoading)
        }
    }
}

/// NSViewRepresentable wrapping a plain WKWebView for loading external URLs.
private struct InAppWebView: NSViewRepresentable {
    let url: URL
    @Binding var title: String
    @Binding var isLoading: Bool

    func makeCoordinator() -> Coordinator {
        Coordinator(title: $title, isLoading: $isLoading)
    }

    func makeNSView(context: Context) -> WKWebView {
        let webView = WKWebView(frame: .zero)
        webView.navigationDelegate = context.coordinator
        webView.allowsLinkPreview = true
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        // URL changes are handled by re-creating the view
    }

    class Coordinator: NSObject, WKNavigationDelegate {
        @Binding var title: String
        @Binding var isLoading: Bool

        init(title: Binding<String>, isLoading: Binding<Bool>) {
            _title = title
            _isLoading = isLoading
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            isLoading = false
            title = webView.title ?? ""
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            isLoading = false
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            isLoading = false
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            // Allow all navigations within the in-app browser
            decisionHandler(.allow)
        }
    }
}
