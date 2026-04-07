import SwiftUI
@preconcurrency import WebKit
import os
import VellumAssistantShared

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "DynamicPage")

/// NSView that clips its subviews to a rounded rect using a CAShapeLayer mask.
/// This reliably clips WKWebView content, which ignores plain masksToBounds.
private class RoundedClipView: NSView {
    var cornerRadius: CGFloat = 0 { didSet { needsLayout = true } }
    var maskedCorners: CACornerMask = [.layerMinXMinYCorner, .layerMaxXMinYCorner, .layerMinXMaxYCorner, .layerMaxXMaxYCorner] { didSet { needsLayout = true } }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
    }

    required init?(coder: NSCoder) { fatalError() }

    override func layout() {
        super.layout()
        guard cornerRadius > 0 else {
            layer?.mask = nil
            return
        }
        let mask = CAShapeLayer()
        mask.path = makeRoundedPath(bounds, radius: cornerRadius, corners: maskedCorners)
        layer?.mask = mask
    }

    /// Build a CGPath with selective corner rounding.
    /// CACornerMask uses CA coordinate space (origin bottom-left), which matches
    /// AppKit's non-flipped NSView. For flipped views the Y mapping inverts, but
    /// NSViewRepresentable hosts are non-flipped by default so the mapping is direct.
    private func makeRoundedPath(_ rect: CGRect, radius r: CGFloat, corners: CACornerMask) -> CGPath {
        let minX = rect.minX, minY = rect.minY, maxX = rect.maxX, maxY = rect.maxY
        let tl = corners.contains(.layerMinXMaxYCorner) ? r : 0  // top-left (CA: minX maxY)
        let tr = corners.contains(.layerMaxXMaxYCorner) ? r : 0  // top-right (CA: maxX maxY)
        let br = corners.contains(.layerMaxXMinYCorner) ? r : 0  // bottom-right (CA: maxX minY)
        let bl = corners.contains(.layerMinXMinYCorner) ? r : 0  // bottom-left (CA: minX minY)
        let path = CGMutablePath()
        path.move(to: CGPoint(x: minX + tl, y: maxY))
        path.addLine(to: CGPoint(x: maxX - tr, y: maxY))
        if tr > 0 { path.addArc(tangent1End: CGPoint(x: maxX, y: maxY), tangent2End: CGPoint(x: maxX, y: maxY - tr), radius: tr) }
        else { path.addLine(to: CGPoint(x: maxX, y: maxY)) }
        path.addLine(to: CGPoint(x: maxX, y: minY + br))
        if br > 0 { path.addArc(tangent1End: CGPoint(x: maxX, y: minY), tangent2End: CGPoint(x: maxX - br, y: minY), radius: br) }
        else { path.addLine(to: CGPoint(x: maxX, y: minY)) }
        path.addLine(to: CGPoint(x: minX + bl, y: minY))
        if bl > 0 { path.addArc(tangent1End: CGPoint(x: minX, y: minY), tangent2End: CGPoint(x: minX, y: minY + bl), radius: bl) }
        else { path.addLine(to: CGPoint(x: minX, y: minY)) }
        path.addLine(to: CGPoint(x: minX, y: maxY - tl))
        if tl > 0 { path.addArc(tangent1End: CGPoint(x: minX, y: maxY), tangent2End: CGPoint(x: minX + tl, y: maxY), radius: tl) }
        else { path.addLine(to: CGPoint(x: minX, y: maxY)) }
        path.closeSubpath()
        return path
    }
}

extension DynamicPageSurfaceView {
    /// CSS design system loaded once from the resource bundle and escaped for JS injection.
    static let designSystemCSS: String = {
        guard let url = ResourceBundle.bundle.url(
            forResource: "vellum-design-system", withExtension: "css"
        ), let css = try? String(contentsOf: url, encoding: .utf8) else {
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
        ), let js = try? String(contentsOf: url, encoding: .utf8) else {
            log.error("Failed to load vellum-widgets.js from resource bundle")
            assertionFailure("vellum-widgets.js not found in resource bundle")
            return ""
        }
        return js
    }()

    // MARK: - Pre-built WKUserScript objects

    /// Design system CSS injection script, built once from the static `designSystemCSS` string.
    static let designSystemUserScript: WKUserScript = {
        WKUserScript(
            source: """
                (function() {
                    var style = document.createElement('style');
                    style.id = 'vellum-design-system';
                    style.setAttribute('data-vellum-injected', '1');
                    style.textContent = `\(designSystemCSS)`;
                    var target = document.head || document.documentElement;
                    target.insertBefore(style, target.firstChild);
                })();
                """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
    }()

    /// Widget JS utilities script, built once from the static `widgetJS` string.
    static let widgetUserScript: WKUserScript = {
        WKUserScript(
            source: widgetJS,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
    }()

    /// Edit animator script for DOM morphing with animation, or nil if the resource is missing.
    static let editAnimatorUserScript: WKUserScript? = {
        guard let url = ResourceBundle.bundle.url(forResource: "vellum-edit-animator", withExtension: "js"),
              let js = try? String(contentsOf: url, encoding: .utf8) else {
            return nil
        }
        return WKUserScript(source: js, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
    }()

    // MARK: - Cached sandbox content rule list

    /// Pre-compiled content rule list for sandbox mode, compiled once and reused.
    /// Blocks all network requests except vellumapp:// and about:blank.
    private static var _cachedSandboxRuleList: WKContentRuleList?
    private static var _sandboxRuleListCompiled = false

    /// Returns the cached sandbox rule list, compiling it on first access.
    static func sandboxRuleList(completion: @escaping (WKContentRuleList?) -> Void) {
        if _sandboxRuleListCompiled {
            completion(_cachedSandboxRuleList)
            return
        }
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
            DispatchQueue.main.async {
                if let error {
                    log.error("Failed to compile sandbox content rule list: \(error.localizedDescription)")
                    // Leave _sandboxRuleListCompiled false so the next sandboxed
                    // surface retries compilation instead of permanently losing
                    // network-blocking rules.
                } else {
                    _cachedSandboxRuleList = ruleList
                    _sandboxRuleListCompiled = true
                }
                completion(ruleList)
            }
        }
    }
}

struct DynamicPageSurfaceView: NSViewRepresentable {
    let data: DynamicPageSurfaceData
    let onAction: (String, Any?) -> Void
    let appId: String?
    let onDataRequest: ((String, String, String?, [String: Any]?) -> Void)?
    let onCoordinatorReady: ((Coordinator) -> Void)?
    /// Called when the user navigates to a different page in a multi-page app.
    let onPageChanged: ((String) -> Void)?
    /// Called with a base64-encoded PNG screenshot after the page finishes loading.
    let onSnapshotCaptured: ((String) -> Void)?
    var onLinkOpen: ((String, [String: Any]?) -> Void)?
    /// When true, blocks all network requests to external origins and restricts navigation.
    let sandboxMode: Bool
    let topContentInset: CGFloat
    let bottomContentInset: CGFloat
    /// Corner radius applied at the AppKit layer to clip WKWebView content.
    let cornerRadius: CGFloat
    /// Which corners to round (defaults to all corners).
    let maskedCorners: CACornerMask

    init(
        data: DynamicPageSurfaceData,
        onAction: @escaping (String, Any?) -> Void,
        appId: String? = nil,
        onDataRequest: ((String, String, String?, [String: Any]?) -> Void)? = nil,
        onCoordinatorReady: ((Coordinator) -> Void)? = nil,
        onPageChanged: ((String) -> Void)? = nil,
        onSnapshotCaptured: ((String) -> Void)? = nil,
        onLinkOpen: ((String, [String: Any]?) -> Void)? = nil,
        sandboxMode: Bool = false,
        topContentInset: CGFloat = 0,
        bottomContentInset: CGFloat = 0,
        cornerRadius: CGFloat = 0,
        maskedCorners: CACornerMask = [.layerMinXMinYCorner, .layerMaxXMinYCorner, .layerMinXMaxYCorner, .layerMaxXMaxYCorner]
    ) {
        self.data = data
        self.onAction = onAction
        self.appId = appId
        self.onDataRequest = onDataRequest
        self.onCoordinatorReady = onCoordinatorReady
        self.onPageChanged = onPageChanged
        self.onSnapshotCaptured = onSnapshotCaptured
        self.onLinkOpen = onLinkOpen
        self.sandboxMode = sandboxMode
        self.topContentInset = topContentInset
        self.bottomContentInset = bottomContentInset
        self.cornerRadius = cornerRadius
        self.maskedCorners = maskedCorners
    }

    func makeCoordinator() -> Coordinator {
        let coordinator = Coordinator(onAction: onAction, onDataRequest: onDataRequest, onPageChanged: onPageChanged, onSnapshotCaptured: onSnapshotCaptured, onLinkOpen: onLinkOpen, currentHTML: data.html, sandboxMode: sandboxMode)
        coordinator.surfaceId = data.appId ?? "ephemeral"
        coordinator.appId = appId
        coordinator.loadStartTime = CFAbsoluteTimeGetCurrent()
        return coordinator
    }

    func makeNSView(context: Context) -> NSView {
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
                openLink: function(url, metadata) {
                    window.webkit.messageHandlers.vellumBridge.postMessage({
                        type: 'open_link', url: String(url), metadata: metadata || {}
                    });
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

        // Inject window.vellum.fetch — an authenticated fetch wrapper that routes
        // requests through the gateway with proper auth headers.
        if let credentials = GatewayHTTPClient.resolveWebViewCredentials() {
            let escapedBaseURL = credentials.baseURL
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "'", with: "\\'")
            let headerEntries = credentials.headers.map { key, value in
                let escapedKey = key
                    .replacingOccurrences(of: "\\", with: "\\\\")
                    .replacingOccurrences(of: "'", with: "\\'")
                let escapedValue = value
                    .replacingOccurrences(of: "\\", with: "\\\\")
                    .replacingOccurrences(of: "'", with: "\\'")
                return "'\(escapedKey)': '\(escapedValue)'"
            }.joined(separator: ", ")

            jsSource += """

                window.vellum.fetch = function(path, options) {
                    options = options || {};
                    var headers = options.headers || {};
                    var authHeaders = {\(headerEntries)};
                    for (var k in authHeaders) {
                        if (!headers[k]) headers[k] = authHeaders[k];
                    }
                    options.headers = headers;
                    var url = '\(escapedBaseURL)' + path;
                    return fetch(url, options);
                };
                """
        }

        jsSource += """

            document.addEventListener('DOMContentLoaded', function() {
                var hasData = !!(window.vellum && window.vellum.data);
                var hasFetch = !!(window.vellum && window.vellum.fetch);
                console.log('[vellum] Bridge check: vellum.data ' + (hasData ? 'available' : 'NOT available (appId not set)') + ', vellum.fetch ' + (hasFetch ? 'available' : 'NOT available'));
            });
            """

        let userScript = WKUserScript(
            source: jsSource,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )

        // Inject CSS custom properties for light/dark theme support at document start.
        let themeScript = WKUserScript(
            source: """
                (function() {
                    var style = document.createElement('style');
                    style.setAttribute('data-vellum-injected', '1');
                    style.textContent = '\(WebTokenInjector.cssTokenBlock().replacingOccurrences(of: "'", with: "\\'").replacingOccurrences(of: "\n", with: " "))';
                    (document.head || document.documentElement).appendChild(style);

                    \(WebTokenInjector.themeEventScript())
                })();
                """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )

        let contentController = WKUserContentController()
        contentController.addUserScript(userScript)
        contentController.addUserScript(themeScript)
        contentController.addUserScript(Self.designSystemUserScript)
        contentController.addUserScript(Self.widgetUserScript)

        if let animatorScript = Self.editAnimatorUserScript {
            contentController.addUserScript(animatorScript)
        }

        contentController.add(context.coordinator, name: "vellumBridge")

        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(
            VellumAppSchemeHandler(),
            forURLScheme: VellumAppSchemeHandler.scheme
        )
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

        if sandboxMode {
            Self.sandboxRuleList { ruleList in
                if let ruleList {
                    webView.configuration.userContentController.add(ruleList)
                    log.info("Sandbox content rule list installed")
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
                        style.setAttribute('data-vellum-injected', '1');
                        style.textContent = 'body { padding-top: \(top)px; padding-bottom: \(bottom)px; }';
                        (document.head || document.documentElement).appendChild(style);
                        if (\(bottom) > 0) {
                            function setupFade() {
                                var fade = document.getElementById('vellum-bottom-fade');
                                if (!fade) {
                                    fade = document.createElement('div');
                                    fade.id = 'vellum-bottom-fade';
                                    fade.setAttribute('data-vellum-injected', '1');
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
        if let appId = appId {
            // User apps are served from the remote assistant runtime via
            // the gateway and loaded inline; they never live on disk.
            let origin = "https://\(appId).vellum.local/"
            context.coordinator.isInlineFallback = true
            webView.loadHTMLString(data.html, baseURL: URL(string: origin))
        } else {
            // Ephemeral surface — inline HTML
            let origin = "https://surface.vellum.local/"
            webView.loadHTMLString(data.html, baseURL: URL(string: origin))
        }
        // Wrap in a RoundedClipView so the WKWebView's layer tree is
        // clipped via a CAShapeLayer mask (masksToBounds alone doesn't work).
        let container = RoundedClipView()
        container.cornerRadius = cornerRadius
        container.maskedCorners = maskedCorners

        webView.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: container.topAnchor),
            webView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
        ])

        return container
    }

    private func fullReload(_ webView: WKWebView, html: String, origin: String, coordinator: Coordinator) {
        let htmlToLoad = html
        webView.evaluateJavaScript("JSON.stringify({x: window.scrollX, y: window.scrollY})") { result, _ in
            guard htmlToLoad == coordinator.currentHTML else { return }
            let scrollState = result as? String
            coordinator.pendingScrollRestore = scrollState
            webView.loadHTMLString(htmlToLoad, baseURL: URL(string: origin))
        }
    }

    func updateNSView(_ containerView: NSView, context: Context) {
        guard let webView = containerView.subviews.first as? WKWebView else { return }
        // Keep clipping container corners in sync (mode may change between .app and .appEditing).
        if let clipView = containerView as? RoundedClipView {
            clipView.cornerRadius = cornerRadius
            clipView.maskedCorners = maskedCorners
        }
        context.coordinator.onAction = onAction
        context.coordinator.onDataRequest = onDataRequest
        context.coordinator.onPageChanged = onPageChanged
        context.coordinator.onLinkOpen = onLinkOpen

        // Refresh timing context when the coordinator is reused across surface navigations
        // so diagnostic logs are attributed to the correct surface/app.
        let newSurfaceId = data.appId ?? "ephemeral"
        if context.coordinator.surfaceId != newSurfaceId || context.coordinator.appId != appId {
            context.coordinator.surfaceId = newSurfaceId
            context.coordinator.appId = appId
        }

        // Keep the coordinator's desired insets up-to-date so webView(_:didFinish:)
        // can re-inject the correct values after a page reload.
        let newTop = Int(topContentInset)
        let newBottom = Int(bottomContentInset)
        context.coordinator.desiredTopInset = newTop
        context.coordinator.desiredBottomInset = newBottom

        // Update the snapshot callback so navigating between surfaces picks up the new closure.
        context.coordinator.onSnapshotCaptured = onSnapshotCaptured


        // For app surfaces, reload on generation change (picks up updates from the gateway)
        if let gen = data.reloadGeneration, gen != context.coordinator.lastReloadGeneration {
            context.coordinator.lastReloadGeneration = gen
            context.coordinator.hasCapturedSnapshot = false
            context.coordinator.loadStartTime = CFAbsoluteTimeGetCurrent()
            // Stash any simultaneous status change for injection after reload completes
            if let status = data.status, status != context.coordinator.lastStatus {
                context.coordinator.pendingStatus = status
                context.coordinator.lastStatus = status
            }
            if context.coordinator.isInlineFallback {
                // Inline fallback: webView.reload() would replay stale HTML.
                // Re-load the current data.html so the update is visible.
                context.coordinator.currentHTML = data.html
                let origin = appId.map { "https://\($0).vellum.local/" } ?? "https://surface.vellum.local/"
                webView.loadHTMLString(data.html, baseURL: URL(string: origin))
            } else {
                webView.reload()
            }
            return
        }
        // Reload if the HTML content has changed.
        if data.html != context.coordinator.currentHTML {
            let previousHTML = context.coordinator.currentHTML
            context.coordinator.currentHTML = data.html
            context.coordinator.hasCapturedSnapshot = false
            context.coordinator.loadStartTime = CFAbsoluteTimeGetCurrent()
            let origin = appId.map { "https://\($0).vellum.local/" } ?? "https://surface.vellum.local/"

            if previousHTML.isEmpty {
                // First load — no scroll to preserve
                webView.loadHTMLString(data.html, baseURL: URL(string: origin))
            } else {
                // Subsequent update — try animated morph, fall back to full reload.
                context.coordinator.morphGeneration += 1
                let currentGen = context.coordinator.morphGeneration
                let htmlForMorph = data.html
                Task { @MainActor in
                    do {
                        let value = try await webView.callAsyncJavaScript(
                            "return await window.vellum.morphWithAnimation(newHTML)",
                            arguments: ["newHTML": htmlForMorph],
                            in: nil,
                            contentWorld: .page
                        )
                        // Stale callback — a newer update has arrived
                        guard context.coordinator.morphGeneration == currentGen else { return }

                        let dict = value as? [String: Any]
                        if dict?["success"] as? Bool == true {
                            // Morph succeeded — trigger snapshot since didFinish won't fire
                            context.coordinator.captureSnapshotAfterMorph(generation: currentGen)
                        } else {
                            self.fullReload(webView, html: htmlForMorph, origin: origin, coordinator: context.coordinator)
                        }
                    } catch {
                        guard context.coordinator.morphGeneration == currentGen else { return }
                        self.fullReload(webView, html: htmlForMorph, origin: origin, coordinator: context.coordinator)
                    }
                }
            }
        }

        // Re-apply content insets and fade overlay when they change (e.g. composer expands).
        if newTop != context.coordinator.lastTopInset || newBottom != context.coordinator.lastBottomInset {
            context.coordinator.lastTopInset = newTop
            context.coordinator.lastBottomInset = newBottom
            let fadeHeight = newBottom + 32
            let js = """
                (function() {
                    var el = document.getElementById('vellum-content-insets');
                    if (!el) { el = document.createElement('style'); el.id = 'vellum-content-insets'; el.setAttribute('data-vellum-injected', '1'); (document.head || document.documentElement).appendChild(el); }
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

        // Show transient status pill overlay
        if let status = data.status, status != context.coordinator.lastStatus {
            context.coordinator.lastStatus = status
            let escapedStatus = status
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "'", with: "\\'")
                .replacingOccurrences(of: "\n", with: " ")
                .replacingOccurrences(of: "\r", with: " ")
            let js = """
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
            webView.evaluateJavaScript(js, completionHandler: nil)
        } else if data.status == nil {
            context.coordinator.lastStatus = nil
        }
    }
    static func dismantleNSView(_ containerView: NSView, coordinator: Coordinator) {
        guard let webView = containerView.subviews.first as? WKWebView else { return }
        // Stop any in-flight loads to release networking resources.
        webView.stopLoading()
        // Remove the message handler to break the strong reference from
        // WKUserContentController -> Coordinator that would otherwise
        // keep the Coordinator (and everything it captures) alive.
        let controller = webView.configuration.userContentController
        controller.removeScriptMessageHandler(forName: "vellumBridge")
        controller.removeAllUserScripts()
        // Nil out the navigation delegate to sever the last reference
        // from the web view back to the coordinator.
        webView.navigationDelegate = nil
    }

}
