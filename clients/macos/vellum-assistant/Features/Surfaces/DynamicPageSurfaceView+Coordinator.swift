import SwiftUI
@preconcurrency import WebKit
import os
import VellumAssistantShared

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "DynamicPage")

extension DynamicPageSurfaceView {

    class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
        var onAction: (String, Any?) -> Void
        var onDataRequest: ((String, String, String?, [String: Any]?) -> Void)?
        var onPageChanged: ((String) -> Void)?
        var onSnapshotCaptured: ((String) -> Void)?
        var onLinkOpen: ((String, [String: Any]?) -> Void)?
        var currentHTML: String
        /// The page currently displayed in a multi-page app (e.g. "settings.html").
        var currentPage: String = "index.html"
        let sandboxMode: Bool
        weak var webView: WKWebView?
        var lastTopInset: Int = 0
        var lastBottomInset: Int = 0
        var desiredTopInset: Int = 0
        var desiredBottomInset: Int = 0
        /// JSON string with {x, y} scroll position to restore after the next page load.
        var pendingScrollRestore: String?
        var hasCapturedSnapshot = false
        var morphGeneration: Int = 0
        var lastReloadGeneration: Int = 0
        /// True when app content is loaded inline via loadHTMLString rather than a scheme URL.
        var isInlineFallback: Bool = false
        var lastStatus: String?
        /// Status message to inject after the next page reload completes.
        var pendingStatus: String?

        // MARK: - Timing diagnostics

        /// Surface and app identifiers for diagnostic log lines.
        var surfaceId: String?
        var appId: String?
        /// Monotonic timestamp (CFAbsoluteTimeGetCurrent) recorded when a page load begins.
        var loadStartTime: CFAbsoluteTime = 0

        /// Log a timing-trail phase with elapsed milliseconds since `loadStartTime`.
        private func logPhase(_ phase: String) {
            let elapsedMs = Int((CFAbsoluteTimeGetCurrent() - loadStartTime) * 1000)
            log.info("[Timing] surface=\(self.surfaceId ?? "nil", privacy: .public) appId=\(self.appId ?? "nil", privacy: .public) page=\(self.currentPage, privacy: .public) phase=\(phase, privacy: .public) elapsed=\(elapsedMs)ms")
        }

        init(
            onAction: @escaping (String, Any?) -> Void,
            onDataRequest: ((String, String, String?, [String: Any]?) -> Void)?,
            onPageChanged: ((String) -> Void)?,
            onSnapshotCaptured: ((String) -> Void)?,
            onLinkOpen: ((String, [String: Any]?) -> Void)? = nil,
            currentHTML: String,
            sandboxMode: Bool = false
        ) {
            self.onAction = onAction
            self.onDataRequest = onDataRequest
            self.onPageChanged = onPageChanged
            self.onSnapshotCaptured = onSnapshotCaptured
            self.onLinkOpen = onLinkOpen
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

            // Handle openLink requests from the JS bridge.
            if let type = body["type"] as? String, type == "open_link" {
                guard let urlString = body["url"] as? String,
                      let url = URL(string: urlString),
                      let scheme = url.scheme?.lowercased(),
                      ["http", "https"].contains(scheme) else {
                    log.warning("open_link: invalid URL")
                    return
                }
                // Sandbox: only allow the Vellum branding domain.
                if sandboxMode {
                    let host = url.host?.lowercased() ?? ""
                    guard host == "vellum.ai" || host.hasSuffix(".vellum.ai") else {
                        log.warning("open_link: blocked in sandbox mode (host=\(host, privacy: .public))")
                        return
                    }
                }
                let metadata = body["metadata"] as? [String: Any]
                onLinkOpen?(urlString, metadata)
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

            // Handle page_changed messages from navigation tracking.
            if let type = body["type"] as? String, type == "page_changed" {
                if let page = body["page"] as? String, page != currentPage {
                    currentPage = page
                    log.info("[WebView] Page changed to: \(page, privacy: .public)")
                    onPageChanged?(page)
                }
                return
            }

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

        /// Captures a screenshot of the current WebView content as a base64-encoded PNG.
        func captureSnapshot(completion: @escaping (String?) -> Void) {
            guard let webView = webView else {
                completion(nil)
                return
            }
            let config = WKSnapshotConfiguration()
            config.afterScreenUpdates = true
            webView.takeSnapshot(with: config) { image, error in
                if let error = error {
                    log.error("Snapshot capture failed: \(error.localizedDescription, privacy: .public)")
                    completion(nil)
                    return
                }
                guard let image = image,
                      let tiff = image.tiffRepresentation,
                      let _ = NSBitmapImageRep(data: tiff) else {
                    completion(nil)
                    return
                }
                // Resize to a reasonable thumbnail (max 400px wide) to keep payload small
                let maxWidth: CGFloat = 400
                let scale = min(1.0, maxWidth / image.size.width)
                let targetSize = NSSize(
                    width: image.size.width * scale,
                    height: image.size.height * scale
                )
                let resized = NSImage(size: targetSize)
                resized.lockFocus()
                image.draw(in: NSRect(origin: .zero, size: targetSize),
                           from: NSRect(origin: .zero, size: image.size),
                           operation: .copy,
                           fraction: 1.0)
                resized.unlockFocus()
                guard let resizedTiff = resized.tiffRepresentation,
                      let resizedBitmap = NSBitmapImageRep(data: resizedTiff),
                      let pngData = resizedBitmap.representation(using: .png, properties: [.compressionFactor: 0.8]) else {
                    completion(nil)
                    return
                }
                completion(pngData.base64EncodedString())
            }
        }

        func captureSnapshotAfterMorph(generation: Int) {
            guard let onSnapshotCaptured else { return }
            logPhase("captureSnapshotAfterMorph:start")
            hasCapturedSnapshot = false
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 500_000_000)
                guard !Task.isCancelled else { return }
                guard let self, self.morphGeneration == generation else { return }
                self.logPhase("captureSnapshotAfterMorph:takeSnapshot")
                self.captureSnapshot { [weak self] base64 in
                    if let base64 {
                        self?.logPhase("captureSnapshotAfterMorph:complete")
                        onSnapshotCaptured(base64)
                    }
                }
            }
        }

        /// Send a content update to the web view via window.vellum.onContentUpdate().
        func sendContentUpdate(_ data: [String: Any]) {
            guard let webView = webView else {
                log.warning("sendContentUpdate: no webView available")
                return
            }

            guard let jsonData = try? JSONSerialization.data(withJSONObject: data),
                  let jsonString = String(data: jsonData, encoding: .utf8) else {
                log.error("sendContentUpdate: failed to serialize data to JSON")
                return
            }

            let safeJSON = jsonString
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "'", with: "\\'")
                .replacingOccurrences(of: "\n", with: "\\n")
                .replacingOccurrences(of: "\r", with: "\\r")

            let script = """
                (function() {
                    try {
                        if (typeof window.vellum !== 'undefined' &&
                            typeof window.vellum.onContentUpdate === 'function') {
                            var data = JSON.parse('\(safeJSON)');
                            window.vellum.onContentUpdate(data);
                        }
                    } catch(e) {
                        console.error('onContentUpdate error:', e);
                    }
                })();
                """

            webView.evaluateJavaScript(script) { result, error in
                if let error = error {
                    log.error("sendContentUpdate: JS eval error: \(error.localizedDescription, privacy: .public)")
                } else {
                    log.debug("sendContentUpdate: successfully sent update")
                }
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            logPhase("didFinish")

            // Restore scroll position if this load was a refinement update.
            if let scrollJSON = pendingScrollRestore {
                pendingScrollRestore = nil
                let safeScrollJSON = scrollJSON
                    .replacingOccurrences(of: "\\", with: "\\\\")
                    .replacingOccurrences(of: "'", with: "\\'")
                    .replacingOccurrences(of: "\n", with: "\\n")
                    .replacingOccurrences(of: "\r", with: "\\r")
                let js = """
                    (function() {
                        try {
                            var s = JSON.parse('\(safeScrollJSON)');
                            window.scrollTo(s.x || 0, s.y || 0);
                        } catch(e) {}
                    })();
                    """
                webView.evaluateJavaScript(js, completionHandler: nil)
            }

            // Re-inject content insets after page load completes. The WKUserScript from
            // makeNSView has creation-time values baked in, which may be stale if insets
            // changed since then (e.g. composer expanded). Apply the current desired values.
            let top = desiredTopInset
            let bottom = desiredBottomInset
            if top > 0 || bottom > 0 || lastTopInset > 0 || lastBottomInset > 0 {
                lastTopInset = top
                lastBottomInset = bottom
                let fadeHeight = bottom + 32
                let js = """
                    (function() {
                        var el = document.getElementById('vellum-content-insets');
                        if (!el) { el = document.createElement('style'); el.id = 'vellum-content-insets'; el.setAttribute('data-vellum-injected', '1'); (document.head || document.documentElement).appendChild(el); }
                        el.textContent = 'body { padding-top: \(top)px; padding-bottom: \(bottom)px; }';
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

            // Inject deferred status pill that was stashed during a reload.
            if let status = pendingStatus {
                pendingStatus = nil
                let escapedStatus = status
                    .replacingOccurrences(of: "\\", with: "\\\\")
                    .replacingOccurrences(of: "'", with: "\\'")
                    .replacingOccurrences(of: "\n", with: " ")
                    .replacingOccurrences(of: "\r", with: " ")
                let pillJS = """
                    (function() {
                        var existing = document.getElementById('vellum-status-pill');
                        if (existing) existing.remove();
                        var pill = document.createElement('div');
                        pill.id = 'vellum-status-pill';
                        pill.setAttribute('data-vellum-injected', '1');
                        pill.textContent = '\(escapedStatus)';
                        pill.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.75);color:#fff;font-size:12px;padding:6px 14px;border-radius:20px;z-index:100000;pointer-events:none;opacity:0;transition:opacity 0.3s ease;backdrop-filter:blur(8px);font-family:-apple-system,BlinkMacSystemFont,sans-serif;';
                        document.body.appendChild(pill);
                        requestAnimationFrame(function() { pill.style.opacity = '1'; });
                        setTimeout(function() {
                            pill.style.opacity = '0';
                            setTimeout(function() { if (pill.parentNode) pill.remove(); }, 300);
                        }, 3000);
                    })();
                    """
                webView.evaluateJavaScript(pillJS, completionHandler: nil)
            }

            // Detect page changes from URL-based navigation (e.g. <a href="settings.html">).
            if let url = webView.url {
                let path = url.path
                let pageName: String
                if path == "/" || path.isEmpty {
                    pageName = "index.html"
                } else {
                    // Extract filename from path (e.g. "/settings.html" → "settings.html")
                    pageName = String(path.dropFirst()) // remove leading "/"
                }
                if !pageName.isEmpty && pageName != currentPage {
                    currentPage = pageName
                    log.info("[WebView] Page detected from URL: \(pageName, privacy: .public)")
                    onPageChanged?(pageName)
                }
            }

            // Capture a preview screenshot after the page has rendered (once per load).
            if !hasCapturedSnapshot, let onSnapshotCaptured {
                hasCapturedSnapshot = true
                logPhase("onSnapshotCaptured:scheduled")
                Task { @MainActor [weak self] in
                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                    guard !Task.isCancelled else { return }
                    self?.logPhase("onSnapshotCaptured:takeSnapshot")
                    self?.captureSnapshot { base64 in
                        if let base64 {
                            self?.logPhase("onSnapshotCaptured:complete")
                            onSnapshotCaptured(base64)
                        }
                    }
                }
            }
        }

        // MARK: - WKUIDelegate

        func webView(
            _ webView: WKWebView,
            runOpenPanelWith parameters: WKOpenPanelParameters,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping ([URL]?) -> Void
        ) {
            let panel = NSOpenPanel()
            panel.allowsMultipleSelection = parameters.allowsMultipleSelection
            panel.canChooseFiles = true
            panel.canChooseDirectories = false
            panel.begin { response in
                completionHandler(response == .OK ? panel.urls : nil)
            }
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
