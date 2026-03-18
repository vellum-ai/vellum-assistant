#if canImport(UIKit)
import SwiftUI
import WebKit
import VellumAssistantShared

/// Renders a video embed (YouTube, Vimeo, Loom) inline in an iOS chat message.
///
/// Shows a placeholder with a play button; tapping loads the embed URL
/// in a WKWebView. Tapping the provider link opens in Safari.
struct InlineVideoEmbedView: View {
    let provider: String
    let videoID: String
    let embedURL: URL

    @StateObject private var stateManager = InlineVideoEmbedStateManager()

    /// The embed URL enriched with autoplay/rel query parameters, built on
    /// first play request. Falls back to the raw `embedURL` if the provider
    /// is unrecognised by `VideoEmbedURLBuilder`.
    private var playerURL: URL {
        VideoEmbedURLBuilder.buildEmbedURL(provider: provider, videoID: videoID) ?? embedURL
    }

    var body: some View {
        VStack(spacing: 0) {
            switch stateManager.state {
            case .placeholder:
                placeholderView
            case .initializing, .playing:
                // Single view for both states so SwiftUI preserves the
                // WKWebView identity across the state transition, avoiding
                // a redundant teardown-and-reload cycle.
                ZStack {
                    videoWebView
                    if stateManager.state == .initializing {
                        ProgressView()
                    }
                }
            case .failed(let message):
                failedView(message)
            }

            // Provider attribution bar
            HStack(spacing: VSpacing.xs) {
                VIconView(.video, size: 10)
                    .foregroundColor(VColor.contentTertiary)
                Text(provider.capitalized)
                    .font(VFont.small)
                    .foregroundColor(VColor.contentTertiary)
                Spacer()
            }
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, VSpacing.xs)
        }
        .background(VColor.surfaceBase)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(VColor.borderBase, lineWidth: 1)
        )
        .frame(maxWidth: .infinity)
    }

    private var placeholderView: some View {
        Button {
            stateManager.requestPlay()
        } label: {
            ZStack {
                if let thumbnailURL = VideoThumbnailURL.thumbnailURL(provider: provider, videoID: videoID) {
                    AsyncImage(url: thumbnailURL) { phase in
                        switch phase {
                        case .success(let image):
                            image
                                .resizable()
                                .aspectRatio(contentMode: .fill)
                                .frame(height: 200)
                                .clipped()
                        case .failure:
                            fallbackPlaceholder
                        case .empty:
                            Color.black.opacity(0.8)
                                .frame(height: 200)
                        @unknown default:
                            fallbackPlaceholder
                        }
                    }
                } else {
                    fallbackPlaceholder
                }

                Circle()
                    .fill(Color.black.opacity(0.7))
                    .frame(width: 56, height: 56)
                    .overlay(
                        VIconView(.play, size: 22)
                            .foregroundColor(.white)
                            .offset(x: 2)
                    )
            }
        }
        .buttonStyle(.plain)
    }

    private var fallbackPlaceholder: some View {
        RoundedRectangle(cornerRadius: VRadius.md)
            .fill(Color.black.opacity(0.8))
            .frame(height: 200)
    }

    private var videoWebView: some View {
        VideoEmbedWebView(
            url: playerURL,
            provider: provider,
            onLoaded: { stateManager.didStartPlaying() },
            onFailed: { stateManager.didFail($0) }
        )
        .frame(height: 200)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
    }

    private func failedView(_ message: String) -> some View {
        VStack(spacing: VSpacing.sm) {
            VIconView(.triangleAlert, size: 24)
                .foregroundColor(VColor.contentTertiary)
            Text("Failed to load video")
                .font(VFont.caption)
                .foregroundColor(VColor.contentSecondary)
            Button("Open in Safari") {
                UIApplication.shared.open(embedURL)
            }
            .font(VFont.caption)
        }
        .frame(height: 200)
        .frame(maxWidth: .infinity)
        .background(Color.black.opacity(0.8)) // Intentional: always-dark video error state
    }
}

/// UIViewRepresentable wrapper for WKWebView to play video embeds.
///
/// Uses an ephemeral (non-persistent) data store so no cookies, local storage,
/// or cache persist between sessions — important for privacy when embedding
/// third-party video players. Enforces navigation policy with per-provider
/// host allowlists matching the macOS implementation.
private struct VideoEmbedWebView: UIViewRepresentable {
    let url: URL
    let provider: String
    let onLoaded: () -> Void
    let onFailed: (String) -> Void

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

    /// URL schemes that are safe to open externally from untrusted embed content.
    static let safeExternalSchemes: Set<String> = ["http", "https", "mailto"]

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.isScrollEnabled = false
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.load(Self.makeRequest(url: url, provider: provider))
        return webView
    }

    static func makeRequest(url: URL, provider: String) -> URLRequest {
        VideoEmbedRequestBuilder.buildRequest(url: url, provider: provider)
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        // Keep coordinator state in sync with the latest SwiftUI values,
        // since SwiftUI may recreate the struct (and its closures) without
        // recreating the coordinator.
        context.coordinator.provider = provider
        context.coordinator.onLoaded = onLoaded
        context.coordinator.onFailed = onFailed
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(provider: provider, onLoaded: onLoaded, onFailed: onFailed)
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

    class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var provider: String
        var onLoaded: () -> Void
        var onFailed: (String) -> Void
        /// The first programmatic navigation is the embed URL we control — always allow it.
        private var hasLoadedInitial = false

        init(provider: String, onLoaded: @escaping () -> Void, onFailed: @escaping (String) -> Void) {
            self.provider = provider
            self.onLoaded = onLoaded
            self.onFailed = onFailed
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
                   VideoEmbedWebView.isAllowedHost(host, forProvider: provider) {
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
            onLoaded()
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            guard !Self.isCancellationError(error) else { return }
            onFailed(error.localizedDescription)
        }

        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: Error
        ) {
            guard !Self.isCancellationError(error) else { return }
            onFailed(error.localizedDescription)
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
                  VideoEmbedWebView.safeExternalSchemes.contains(scheme) else {
                return
            }
            UIApplication.shared.open(url)
        }
    }
}
#endif
