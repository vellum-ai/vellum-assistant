import SwiftUI
@preconcurrency import WebKit
import os
import VellumAssistantShared

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "DynamicPage")

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
    let userAppsDirectory: URL?
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
        userAppsDirectory: URL? = nil,
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
        self.userAppsDirectory = userAppsDirectory
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

        let designSystemScript = WKUserScript(
            source: """
                (function() {
                    var style = document.createElement('style');
                    style.id = 'vellum-design-system';
                    style.setAttribute('data-vellum-injected', '1');
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
        contentController.addUserScript(themeScript)
        contentController.addUserScript(designSystemScript)
        contentController.addUserScript(widgetScript)

        // Edit animator — DOM morphing with animation (runs at document end so window.vellum exists).
        if let animatorURL = ResourceBundle.bundle.url(forResource: "vellum-edit-animator", withExtension: "js"),
           let animatorJS = try? String(contentsOf: animatorURL) {
            let animatorScript = WKUserScript(source: animatorJS, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
            contentController.addUserScript(animatorScript)
        }

        contentController.add(context.coordinator, name: "vellumBridge")

        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(
            VellumAppSchemeHandler(
                userAppsDirectory: userAppsDirectory ?? VellumAppSchemeHandler.userAppsDirectory
            ),
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

        // Inject "Built on Vellum" branding badge at document end.
        let brandingScript = WKUserScript(
            source: """
                (function() {
                    function injectBranding() {
                        if (document.getElementById('vellum-branding')) return;
                        var el = document.createElement('div');
                        el.id = 'vellum-branding';
                        el.setAttribute('data-vellum-injected', '1');
                        el.innerHTML = 'Built on <a onclick="event.preventDefault(); if(window.vellum&&vellum.openLink){vellum.openLink(\\'https://vellum.ai\\',{provider:\\'vellum\\',type:\\'branding\\'})}else{window.open(\\'https://vellum.ai\\',\\'_blank\\')}" href="https://vellum.ai">Vellum</a>';
                        document.body.appendChild(el);
                    }
                    if (document.body) injectBranding();
                    else document.addEventListener('DOMContentLoaded', injectBranding);
                })();
                """,
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        )
        contentController.addUserScript(brandingScript)

        onCoordinatorReady?(context.coordinator)
        // Use a per-app origin so localStorage/sessionStorage work natively,
        // isolated per app. Non-app surfaces get a shared fallback origin.
        if let appId = appId {
            // App-backed surface — serve from disk via scheme handler.
            // Use dirName for filesystem paths (may differ from appId/UUID).
            let localDir = data.dirName ?? appId
            // Multifile apps have a compiled dist/ directory; prefer it over root index.html.
            let appsDirectory = userAppsDirectory ?? VellumAppSchemeHandler.userAppsDirectory
            let appDir = appsDirectory.appendingPathComponent(localDir)
            let appDirExists = FileManager.default.fileExists(atPath: appDir.path)

            if !appDirExists {
                // App directory not on host (e.g. Docker instance) — load
                // the HTML returned by the open API inline. Use the same
                // https:// origin that updateNSView uses so localStorage
                // persists across HTML updates and relative assets don't
                // try to load via the scheme handler.
                let origin = "https://\(appId).vellum.local/"
                context.coordinator.isInlineFallback = true
                webView.loadHTMLString(data.html, baseURL: URL(string: origin))
            } else {
                let distIndex = appDir.appendingPathComponent("dist/index.html")
                let hasSrcDir = FileManager.default.fileExists(atPath: appDir.appendingPathComponent("src").path)

                if hasSrcDir && !FileManager.default.fileExists(atPath: distIndex.path) {
                    // Multifile app whose dist/ hasn't been compiled yet — show a
                    // "building" placeholder that auto-retries by navigating to the
                    // scheme URL (not reload, which would just re-render this inline HTML).
                    let distSchemeURL = "vellumapp://\(localDir)/dist/index.html"
                    let origin = "vellumapp://\(localDir)/"
                    let buildingHTML = """
                    <!DOCTYPE html><html><head><meta charset="UTF-8">
                    <style>body{display:flex;align-items:center;justify-content:center;height:100vh;margin:0;
                    font-family:system-ui;color:#666;background:#fafafa}
                    .c{text-align:center}.spin{animation:r 1s linear infinite;font-size:24px;display:inline-block}
                    @keyframes r{to{transform:rotate(360deg)}}
                    button{margin-top:12px;padding:8px 16px;border:1px solid #ccc;border-radius:6px;
                    background:#fff;cursor:pointer;font-size:13px}button:hover{background:#f0f0f0}</style>
                    </head><body><div class="c"><div class="spin">⚙️</div><p>Building app…</p>
                    <button onclick="window.location.href='\(distSchemeURL)'">Refresh</button></div>
                    <script>setTimeout(()=>{window.location.href='\(distSchemeURL)'},2000)</script></body></html>
                    """
                    webView.loadHTMLString(buildingHTML, baseURL: URL(string: origin))
                } else {
                    let entryPath = FileManager.default.fileExists(atPath: distIndex.path)
                        ? "dist/index.html"
                        : "index.html"
                    let schemeURL = URL(string: "vellumapp://\(localDir)/\(entryPath)")!
                    webView.load(URLRequest(url: schemeURL))
                }
            }
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

        // Keep the coordinator's desired insets up-to-date so webView(_:didFinish:)
        // can re-inject the correct values after a page reload.
        let newTop = Int(topContentInset)
        let newBottom = Int(bottomContentInset)
        context.coordinator.desiredTopInset = newTop
        context.coordinator.desiredBottomInset = newBottom

        // Update the snapshot callback so navigating between surfaces picks up the new closure.
        context.coordinator.onSnapshotCaptured = onSnapshotCaptured


        // For file-based apps, reload on generation change (picks up CSS/JS/HTML edits)
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
    static func dismantleNSView(_ webView: WKWebView, coordinator: Coordinator) {
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

    // MARK: - Coordinator

    class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
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
        /// True when the app directory is missing and content is loaded inline via data.html.
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
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                guard let self, self.morphGeneration == generation else { return }
                self.logPhase("captureSnapshotAfterMorph:takeSnapshot")
                self.captureSnapshot { base64 in
                    if let base64 {
                        self.logPhase("captureSnapshotAfterMorph:complete")
                        onSnapshotCaptured(base64)
                    }
                }
            }
        }

        /// Send a content update to the web view via window.vellum.onContentUpdate().
        /// Used by document editor to receive content updates from the daemon.
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
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
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
