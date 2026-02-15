import SwiftUI
@preconcurrency import WebKit
import os
import VellumAssistantShared

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "DynamicPage")

extension DynamicPageSurfaceView {
    /// CSS design system loaded once from the resource bundle and escaped for JS injection.
    static let designSystemCSS: String = {
        guard let url = ResourceBundle.bundle.url(
            forResource: "vellum-design-system", withExtension: "css"
        ), let css = try? String(contentsOf: url) else {
            log.error("Failed to load vellum-design-system.css from resource bundle")
            assertionFailure("vellum-design-system.css not found in resource bundle")
            return ""
        }
        return css
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "`", with: "\\`")
            .replacingOccurrences(of: "${", with: "\\${")
            .replacingOccurrences(of: "\r", with: "")
    }()

    /// Widget JS utilities loaded once from the resource bundle.
    static let widgetJS: String = {
        guard let url = ResourceBundle.bundle.url(
            forResource: "vellum-widgets", withExtension: "js"
        ), let js = try? String(contentsOf: url) else {
            log.error("Failed to load vellum-widgets.js from resource bundle")
            assertionFailure("vellum-widgets.js not found in resource bundle")
            return ""
        }
        return js
    }()
}

struct DynamicPageSurfaceView: NSViewRepresentable {
    let data: DynamicPageSurfaceData
    let onAction: (String, Any?) -> Void
    let appId: String?
    let onDataRequest: ((String, String, String?, [String: Any]?) -> Void)?
    let onCoordinatorReady: ((Coordinator) -> Void)?
    /// When true, blocks all network requests to external origins and restricts navigation.
    let sandboxMode: Bool
    let topContentInset: CGFloat
    let bottomContentInset: CGFloat

    init(
        data: DynamicPageSurfaceData,
        onAction: @escaping (String, Any?) -> Void,
        appId: String? = nil,
        onDataRequest: ((String, String, String?, [String: Any]?) -> Void)? = nil,
        onCoordinatorReady: ((Coordinator) -> Void)? = nil,
        sandboxMode: Bool = false,
        topContentInset: CGFloat = 0,
        bottomContentInset: CGFloat = 0
    ) {
        self.data = data
        self.onAction = onAction
        self.appId = appId
        self.onDataRequest = onDataRequest
        self.onCoordinatorReady = onCoordinatorReady
        self.sandboxMode = sandboxMode
        self.topContentInset = topContentInset
        self.bottomContentInset = bottomContentInset
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(onAction: onAction, onDataRequest: onDataRequest, currentHTML: data.html, sandboxMode: sandboxMode)
    }

    func makeNSView(context: Context) -> WKWebView {
        // Console forwarding: capture JS console.log/error/warn and route to os.Logger.
        var jsSource = """
            (function() {
                var _origLog = console.log, _origErr = console.error, _origWarn = console.warn;
                function _fwd(level, args) {
                    try {
                        var msg = Array.prototype.map.call(args, function(a) {
                            return typeof a === 'object' ? JSON.stringify(a) : String(a);
                        }).join(' ');
                        window.webkit.messageHandlers.vellumBridge.postMessage({
                            type: 'console', level: level, message: msg
                        });
                    } catch(e) {}
                }
                console.log = function() { _fwd('log', arguments); _origLog.apply(console, arguments); };
                console.error = function() { _fwd('error', arguments); _origErr.apply(console, arguments); };
                console.warn = function() { _fwd('warn', arguments); _origWarn.apply(console, arguments); };
                window.onerror = function(msg, url, line, col, err) {
                    _fwd('error', ['Uncaught: ' + msg + ' at line ' + line + ':' + col]);
                };
                window.onunhandledrejection = function(e) {
                    _fwd('error', ['Unhandled rejection: ' + (e.reason || e)]);
                };
            })();
            // In-memory localStorage/sessionStorage polyfill.
            // The sandboxed WKWebView has an opaque origin so real Storage throws SecurityError.
            (function() {
                function MemoryStorage() { this._data = {}; }
                MemoryStorage.prototype.getItem = function(k) { return this._data.hasOwnProperty(k) ? this._data[k] : null; };
                MemoryStorage.prototype.setItem = function(k, v) { this._data[k] = String(v); };
                MemoryStorage.prototype.removeItem = function(k) { delete this._data[k]; };
                MemoryStorage.prototype.clear = function() { this._data = {}; };
                MemoryStorage.prototype.key = function(i) { var keys = Object.keys(this._data); return i < keys.length ? keys[i] : null; };
                Object.defineProperty(MemoryStorage.prototype, 'length', { get: function() { return Object.keys(this._data).length; } });
                try { localStorage.setItem('__test__', '1'); localStorage.removeItem('__test__'); } catch(e) {
                    Object.defineProperty(window, 'localStorage', { value: new MemoryStorage(), writable: false });
                    Object.defineProperty(window, 'sessionStorage', { value: new MemoryStorage(), writable: false });
                }
            })();
            window.vellum = {
                sendAction: function(actionId, data) {
                    window.webkit.messageHandlers.vellumBridge.postMessage({actionId: actionId, data: data});
                },
                openExternal: function(url) {
                    window.webkit.messageHandlers.vellumBridge.postMessage({type: 'open_external', url: String(url)});
                },
                _confirmPending: {},
                _confirmNextId: 1,
                confirm: function(title, message) {
                    return new Promise(function(resolve) {
                        var confirmId = 'confirm_' + (window.vellum._confirmNextId++);
                        window.vellum._confirmPending[confirmId] = resolve;
                        window.webkit.messageHandlers.vellumBridge.postMessage({
                            type: 'confirm', confirmId: confirmId, title: String(title || ''), message: String(message || '')
                        });
                    });
                },
                _resolveConfirm: function(confirmId, result) {
                    var p = window.vellum._confirmPending[confirmId];
                    if (p) { delete window.vellum._confirmPending[confirmId]; p(result); }
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
                        if (!p) {
                            console.warn('[vellum.data] _resolve called for unknown callId:', callId);
                            return;
                        }
                        delete this._pending[callId];
                        if (success) p.resolve(result); else p.reject(new Error(error || 'Unknown error'));
                    }
                };
                """
        }

        jsSource += """

            document.addEventListener('DOMContentLoaded', function() {
                var hasData = !!(window.vellum && window.vellum.data);
                console.log('[vellum] Bridge check: vellum.data ' + (hasData ? 'available' : 'NOT available (appId not set)'));
            });
            """

        let userScript = WKUserScript(
            source: jsSource,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )

        let designSystemScript = WKUserScript(
            source: """
                (function() {
                    var style = document.createElement('style');
                    style.id = 'vellum-design-system';
                    style.textContent = `\(Self.designSystemCSS)`;
                    var target = document.head || document.documentElement;
                    target.insertBefore(style, target.firstChild);
                })();
                """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )

        // Widget JS utilities (charts, formatting, interactive behaviors).
        // Runs after the bridge script so window.vellum is already defined.
        let widgetScript = WKUserScript(
            source: Self.widgetJS,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )

        let contentController = WKUserContentController()
        contentController.addUserScript(userScript)
        contentController.addUserScript(designSystemScript)
        contentController.addUserScript(widgetScript)
        contentController.add(context.coordinator, name: "vellumBridge")

        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(VellumAppSchemeHandler(), forURLScheme: VellumAppSchemeHandler.scheme)
        configuration.userContentController = contentController

        #if DEBUG
        // Enable Safari Web Inspector for debugging WKWebView content.
        let webInspectorKey = ["developer", "Extras", "Enabled"].joined()
        configuration.preferences.setValue(true, forKey: webInspectorKey)
        #endif

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.allowsLinkPreview = false
        webView.navigationDelegate = context.coordinator
        context.coordinator.webView = webView

        log.info("Creating DynamicPageSurfaceView: appId=\(self.appId ?? "nil", privacy: .public), dataBridge=\(self.appId != nil ? "injected" : "skipped", privacy: .public), sandboxMode=\(self.sandboxMode)")

        // When sandbox mode is enabled, compile a content rule list that blocks
        // all network requests except those to the vellumapp:// scheme.
        if sandboxMode {
            let ruleJSON = """
            [
                {
                    "trigger": { "url-filter": ".*" },
                    "action": { "type": "block" }
                },
                {
                    "trigger": { "url-filter": "^vellumapp://.*" },
                    "action": { "type": "ignore-previous-rules" }
                },
                {
                    "trigger": { "url-filter": "^about:blank$" },
                    "action": { "type": "ignore-previous-rules" }
                }
            ]
            """
            WKContentRuleListStore.default().compileContentRuleList(
                forIdentifier: "sandbox-block-external",
                encodedContentRuleList: ruleJSON
            ) { ruleList, error in
                if let ruleList {
                    webView.configuration.userContentController.add(ruleList)
                    log.info("Sandbox content rule list installed")
                } else if let error {
                    log.error("Failed to compile sandbox content rule list: \(error.localizedDescription)")
                }
            }
        }

        // Inject CSS padding so HTML content doesn't get hidden behind floating overlays,
        // plus a fixed-position fade overlay that uses the page's own background color.
        if topContentInset > 0 || bottomContentInset > 0 {
            let top = Int(topContentInset)
            let bottom = Int(bottomContentInset)
            let fadeHeight = bottom + 32
            let insetScript = WKUserScript(
                source: """
                    (function() {
                        var style = document.createElement('style');
                        style.id = 'vellum-content-insets';
                        style.textContent = 'body { padding-top: \(top)px; padding-bottom: \(bottom)px; }';
                        (document.head || document.documentElement).appendChild(style);
                        if (\(bottom) > 0) {
                            function setupFade() {
                                var fade = document.getElementById('vellum-bottom-fade');
                                if (!fade) {
                                    fade = document.createElement('div');
                                    fade.id = 'vellum-bottom-fade';
                                    fade.style.cssText = 'position:fixed;bottom:0;left:0;right:0;pointer-events:none;z-index:99999;';
                                    document.body.appendChild(fade);
                                }
                                fade.style.height = '\(fadeHeight)px';
                                requestAnimationFrame(function() {
                                    var bg = getComputedStyle(document.body).backgroundColor || 'rgba(0,0,0,0)';
                                    fade.style.background = 'linear-gradient(to bottom, transparent 0%, ' + bg + ' 100%)';
                                });
                            }
                            if (document.body) setupFade();
                            else document.addEventListener('DOMContentLoaded', setupFade);
                        }
                    })();
                    """,
                injectionTime: .atDocumentEnd,
                forMainFrameOnly: true
            )
            contentController.addUserScript(insetScript)
        }

        onCoordinatorReady?(context.coordinator)
        // Use a per-app origin so localStorage/sessionStorage work natively,
        // isolated per app. Non-app surfaces get a shared fallback origin.
        let origin = appId.map { "https://\($0).vellum.local/" } ?? "https://surface.vellum.local/"
        webView.loadHTMLString(data.html, baseURL: URL(string: origin))

        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        context.coordinator.onAction = onAction
        context.coordinator.onDataRequest = onDataRequest

        // Reload if the HTML content has changed.
        if data.html != context.coordinator.currentHTML {
            context.coordinator.currentHTML = data.html
            let origin = appId.map { "https://\($0).vellum.local/" } ?? "https://surface.vellum.local/"
            webView.loadHTMLString(data.html, baseURL: URL(string: origin))
        }

        // Re-apply content insets and fade overlay when they change (e.g. composer expands).
        let newTop = Int(topContentInset)
        let newBottom = Int(bottomContentInset)
        if newTop != context.coordinator.lastTopInset || newBottom != context.coordinator.lastBottomInset {
            context.coordinator.lastTopInset = newTop
            context.coordinator.lastBottomInset = newBottom
            let fadeHeight = newBottom + 32
            let js = """
                (function() {
                    var el = document.getElementById('vellum-content-insets');
                    if (!el) { el = document.createElement('style'); el.id = 'vellum-content-insets'; (document.head || document.documentElement).appendChild(el); }
                    el.textContent = 'body { padding-top: \(newTop)px; padding-bottom: \(newBottom)px; }';
                    var fade = document.getElementById('vellum-bottom-fade');
                    if (fade) {
                        fade.style.height = '\(fadeHeight)px';
                        var bg = getComputedStyle(document.body).backgroundColor || 'rgba(0,0,0,0)';
                        fade.style.background = 'linear-gradient(to bottom, transparent 0%, ' + bg + ' 100%)';
                    }
                })();
                """
            webView.evaluateJavaScript(js, completionHandler: nil)
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
        let sandboxMode: Bool
        weak var webView: WKWebView?
        var lastTopInset: Int = 0
        var lastBottomInset: Int = 0

        init(
            onAction: @escaping (String, Any?) -> Void,
            onDataRequest: ((String, String, String?, [String: Any]?) -> Void)?,
            currentHTML: String,
            sandboxMode: Bool = false
        ) {
            self.onAction = onAction
            self.onDataRequest = onDataRequest
            self.currentHTML = currentHTML
            self.sandboxMode = sandboxMode
        }

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard let body = message.body as? [String: Any] else { return }

            // Forward JS console messages to os.Logger.
            if let type = body["type"] as? String, type == "console" {
                let level = body["level"] as? String ?? "log"
                let msg = body["message"] as? String ?? ""
                switch level {
                case "error":
                    log.error("[WebView] \(msg, privacy: .public)")
                case "warn":
                    log.warning("[WebView] \(msg, privacy: .public)")
                default:
                    log.info("[WebView] \(msg, privacy: .public)")
                }
                return
            }

            // Handle data_request messages from the RPC bridge.
            if let type = body["type"] as? String, type == "data_request" {
                guard let callId = body["callId"] as? String,
                      let method = body["method"] as? String else {
                    log.error("data_request missing callId or method: \(String(describing: body), privacy: .public)")
                    return
                }
                let recordId = body["recordId"] as? String
                let data = body["data"] as? [String: Any]
                log.info("data_request: method=\(method, privacy: .public), callId=\(callId, privacy: .public), recordId=\(recordId ?? "nil", privacy: .public), hasData=\(data != nil)")
                if onDataRequest == nil {
                    log.error("data_request received but onDataRequest callback is nil — appId was likely not set")
                }
                onDataRequest?(callId, method, recordId, data)
                return
            }

            // Handle openExternal requests from the JS bridge.
            if let type = body["type"] as? String, type == "open_external" {
                if sandboxMode {
                    log.warning("open_external: blocked in sandbox mode")
                    return
                }
                guard let urlString = body["url"] as? String,
                      let url = URL(string: urlString),
                      let scheme = url.scheme?.lowercased(),
                      ["http", "https", "mailto"].contains(scheme) else {
                    log.warning("open_external: blocked invalid or disallowed URL: \(body["url"] as? String ?? "nil", privacy: .public)")
                    return
                }
                NSWorkspace.shared.open(url)
                return
            }

            // Handle confirm dialog requests from the JS bridge.
            if let type = body["type"] as? String, type == "confirm" {
                guard let confirmId = body["confirmId"] as? String else {
                    log.error("confirm: missing confirmId")
                    return
                }
                let title = body["title"] as? String ?? ""
                let msg = body["message"] as? String ?? ""
                let alert = NSAlert()
                alert.messageText = title
                alert.informativeText = msg
                alert.alertStyle = .informational
                alert.addButton(withTitle: "OK")
                alert.addButton(withTitle: "Cancel")
                let response = alert.runModal()
                let confirmed = response == .alertFirstButtonReturn
                let safeId = confirmId
                    .replacingOccurrences(of: "\\", with: "\\\\")
                    .replacingOccurrences(of: "'", with: "\\'")
                    .replacingOccurrences(of: "\n", with: "\\n")
                    .replacingOccurrences(of: "\r", with: "\\r")
                let js = "window.vellum._resolveConfirm('\(safeId)', \(confirmed))"
                webView?.evaluateJavaScript(js) { _, error in
                    if let error {
                        log.error("confirm: JS eval error: \(error.localizedDescription, privacy: .public)")
                    }
                }
                return
            }

            // Existing sendAction handling.
            guard let actionId = body["actionId"] as? String else { return }
            let data = body["data"]
            onAction(actionId, data)
        }

        func resolveDataResponse(_ response: AppDataResponseMessage) {
            log.info("resolveDataResponse: callId=\(response.callId, privacy: .public), success=\(response.success), hasResult=\(response.result != nil), error=\(response.error ?? "nil", privacy: .public)")

            let resultJson: String
            if let result = response.result {
                if let jsonData = try? JSONEncoder().encode(result),
                   let jsonStr = String(data: jsonData, encoding: .utf8) {
                    resultJson = jsonStr
                } else {
                    log.error("resolveDataResponse: failed to re-encode AnyCodable result to JSON")
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

            let js = "window.vellum.data._resolve('\(safeCallId)', \(response.success), \(resultJson), \(errorStr))"

            guard let webView else {
                log.error("resolveDataResponse: webView is nil, cannot evaluate JS")
                return
            }

            webView.evaluateJavaScript(js) { _, error in
                if let error {
                    log.error("resolveDataResponse: JS eval error: \(error.localizedDescription, privacy: .public)")
                }
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            // No auto-resize — the panel opens at a fixed default size and the user can
            // resize manually. Content scrolls if it overflows.
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            if sandboxMode {
                // In sandbox mode, only allow vellumapp:// and about:blank URLs
                if let url = navigationAction.request.url {
                    let scheme = url.scheme?.lowercased() ?? ""
                    if scheme == VellumAppSchemeHandler.scheme || url.absoluteString == "about:blank" {
                        decisionHandler(.allow)
                        return
                    }
                    // Allow initial HTML load via https://*.vellum.local/
                    if scheme == "https" && (url.host?.hasSuffix(".vellum.local") == true) && navigationAction.navigationType == .other {
                        decisionHandler(.allow)
                        return
                    }
                }
                log.info("Sandbox mode: blocking navigation to \(navigationAction.request.url?.absoluteString ?? "nil", privacy: .public)")
                decisionHandler(.cancel)
            } else {
                if navigationAction.navigationType == .other {
                    decisionHandler(.allow)
                } else if navigationAction.navigationType == .linkActivated,
                          let url = navigationAction.request.url,
                          let scheme = url.scheme?.lowercased(),
                          ["http", "https", "mailto"].contains(scheme) {
                    NSWorkspace.shared.open(url)
                    decisionHandler(.cancel)
                } else {
                    decisionHandler(.cancel)
                }
            }
        }
    }
}
