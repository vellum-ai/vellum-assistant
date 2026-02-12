import SwiftUI
import WebKit

struct DynamicPageSurfaceView: NSViewRepresentable {
    let data: DynamicPageSurfaceData
    let onAction: (String, Any?) -> Void
    let appId: String?
    let onDataRequest: ((String, String, String?, [String: Any]?) -> Void)?
    let onCoordinatorReady: ((Coordinator) -> Void)?

    init(
        data: DynamicPageSurfaceData,
        onAction: @escaping (String, Any?) -> Void,
        appId: String? = nil,
        onDataRequest: ((String, String, String?, [String: Any]?) -> Void)? = nil,
        onCoordinatorReady: ((Coordinator) -> Void)? = nil
    ) {
        self.data = data
        self.onAction = onAction
        self.appId = appId
        self.onDataRequest = onDataRequest
        self.onCoordinatorReady = onCoordinatorReady
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(onAction: onAction, onDataRequest: onDataRequest, currentHTML: data.html)
    }

    func makeNSView(context: Context) -> WKWebView {
        var jsSource = """
            window.vellum = {
                sendAction: function(actionId, data) {
                    window.webkit.messageHandlers.vellumBridge.postMessage({actionId: actionId, data: data});
                }
            };
            """

        if appId != nil {
            jsSource += """

                window.vellum.data = {
                    _pending: {},
                    _nextId: 1,
                    _call: function(method, params) {
                        return new Promise(function(resolve, reject) {
                            var callId = 'c' + (window.vellum.data._nextId++);
                            window.vellum.data._pending[callId] = { resolve: resolve, reject: reject };
                            var msg = { type: 'data_request', callId: callId, method: method };
                            if (params.recordId !== undefined) msg.recordId = params.recordId;
                            if (params.data !== undefined) msg.data = params.data;
                            window.webkit.messageHandlers.vellumBridge.postMessage(msg);
                        });
                    },
                    query: function() { return this._call('query', {}); },
                    create: function(data) { return this._call('create', { data: data }); },
                    update: function(recordId, data) { return this._call('update', { recordId: recordId, data: data }); },
                    delete: function(recordId) { return this._call('delete', { recordId: recordId }); },
                    _resolve: function(callId, success, result, error) {
                        var p = this._pending[callId];
                        if (!p) return;
                        delete this._pending[callId];
                        if (success) p.resolve(result); else p.reject(new Error(error || 'Unknown error'));
                    }
                };
                """
        }

        let userScript = WKUserScript(
            source: jsSource,
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
        context.coordinator.webView = webView
        onCoordinatorReady?(context.coordinator)
        webView.loadHTMLString(data.html, baseURL: nil)

        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        context.coordinator.onAction = onAction
        context.coordinator.onDataRequest = onDataRequest

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
        var onDataRequest: ((String, String, String?, [String: Any]?) -> Void)?
        var currentHTML: String
        weak var webView: WKWebView?

        init(
            onAction: @escaping (String, Any?) -> Void,
            onDataRequest: ((String, String, String?, [String: Any]?) -> Void)?,
            currentHTML: String
        ) {
            self.onAction = onAction
            self.onDataRequest = onDataRequest
            self.currentHTML = currentHTML
        }

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard let body = message.body as? [String: Any] else { return }

            // Handle data_request messages from the RPC bridge.
            if let type = body["type"] as? String, type == "data_request" {
                guard let callId = body["callId"] as? String,
                      let method = body["method"] as? String else { return }
                let recordId = body["recordId"] as? String
                let data = body["data"] as? [String: Any]
                onDataRequest?(callId, method, recordId, data)
                return
            }

            // Existing sendAction handling.
            guard let actionId = body["actionId"] as? String else { return }
            let data = body["data"]
            onAction(actionId, data)
        }

        func resolveDataResponse(_ response: AppDataResponseMessage) {
            let resultJson: String
            if let result = response.result {
                if let jsonData = try? JSONEncoder().encode(result),
                   let jsonStr = String(data: jsonData, encoding: .utf8) {
                    resultJson = jsonStr
                } else {
                    resultJson = "null"
                }
            } else {
                resultJson = "null"
            }
            let errorStr: String
            if let error = response.error {
                let escaped = error
                    .replacingOccurrences(of: "\\", with: "\\\\")
                    .replacingOccurrences(of: "'", with: "\\'")
                    .replacingOccurrences(of: "\n", with: "\\n")
                    .replacingOccurrences(of: "\r", with: "\\r")
                errorStr = "'\(escaped)'"
            } else {
                errorStr = "null"
            }
            let safeCallId = response.callId
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "'", with: "\\'")
                .replacingOccurrences(of: "\n", with: "\\n")
                .replacingOccurrences(of: "\r", with: "\\r")
            webView?.evaluateJavaScript(
                "window.vellum.data._resolve('\(safeCallId)', \(response.success), \(resultJson), \(errorStr))"
            )
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            webView.evaluateJavaScript(
                "JSON.stringify({w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight})"
            ) { result, _ in
                guard let json = result as? String,
                      let data = json.data(using: .utf8),
                      let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let w = (dict["w"] as? NSNumber).map({ CGFloat($0.doubleValue) }),
                      let h = (dict["h"] as? NSNumber).map({ CGFloat($0.doubleValue) }),
                      let window = webView.window else { return }

                let screen = NSScreen.main?.visibleFrame ?? window.screen?.visibleFrame
                    ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
                let maxW = min(screen.width * 0.85, 1200)
                let maxH = min(screen.height * 0.85, 1000)
                // Add padding for title bar and container chrome
                let targetW = min(max(w + 40, window.frame.width), maxW)
                let targetH = min(max(h + 80, window.frame.height), maxH)

                // Resize keeping center position
                let currentCenter = NSPoint(x: window.frame.midX, y: window.frame.midY)
                let newOrigin = NSPoint(x: currentCenter.x - targetW / 2, y: currentCenter.y - targetH / 2)
                window.setFrame(
                    NSRect(x: newOrigin.x, y: newOrigin.y, width: targetW, height: targetH),
                    display: true,
                    animate: true
                )
            }
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
