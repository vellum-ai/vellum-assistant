import SwiftUI
import WebKit

struct DynamicPageSurfaceView: NSViewRepresentable {
    let data: DynamicPageSurfaceData
    let onAction: (String, Any?) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onAction: onAction, currentHTML: data.html)
    }

    func makeNSView(context: Context) -> WKWebView {
        let userScript = WKUserScript(
            source: """
                window.vellum = {
                    sendAction: function(actionId, data) {
                        window.webkit.messageHandlers.vellumBridge.postMessage({actionId: actionId, data: data});
                    }
                };
                """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )

        let contentController = WKUserContentController()
        contentController.addUserScript(userScript)
        contentController.add(context.coordinator, name: "vellumBridge")

        let configuration = WKWebViewConfiguration()
        configuration.userContentController = contentController

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.allowsLinkPreview = false
        webView.navigationDelegate = context.coordinator
        webView.loadHTMLString(data.html, baseURL: nil)

        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        context.coordinator.onAction = onAction

        // Reload if the HTML content has changed.
        if data.html != context.coordinator.currentHTML {
            context.coordinator.currentHTML = data.html
            webView.loadHTMLString(data.html, baseURL: nil)
        }
    }

    static func dismantleNSView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "vellumBridge")
    }

    // MARK: - Coordinator

    class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        var onAction: (String, Any?) -> Void
        var currentHTML: String

        init(onAction: @escaping (String, Any?) -> Void, currentHTML: String) {
            self.onAction = onAction
            self.currentHTML = currentHTML
        }

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard let body = message.body as? [String: Any],
                  let actionId = body["actionId"] as? String else {
                return
            }
            let data = body["data"]
            onAction(actionId, data)
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            if navigationAction.navigationType == .other {
                decisionHandler(.allow)
            } else {
                decisionHandler(.cancel)
            }
        }
    }
}
