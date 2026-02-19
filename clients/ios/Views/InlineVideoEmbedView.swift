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

    var body: some View {
        VStack(spacing: 0) {
            switch stateManager.state {
            case .placeholder:
                placeholderView
            case .initializing:
                ZStack {
                    videoWebView
                    ProgressView()
                }
            case .playing:
                videoWebView
            case .failed(let message):
                failedView(message)
            }

            // Provider attribution bar
            HStack(spacing: VSpacing.xs) {
                Image(systemName: "play.rectangle.fill")
                    .font(.system(size: 10))
                    .foregroundColor(VColor.textMuted)
                Text(provider.capitalized)
                    .font(VFont.small)
                    .foregroundColor(VColor.textMuted)
                Spacer()
            }
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, VSpacing.xs)
        }
        .background(VColor.backgroundSubtle)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(VColor.surfaceBorder, lineWidth: 1)
        )
        .frame(maxWidth: .infinity)
    }

    private var placeholderView: some View {
        Button {
            stateManager.requestPlay()
        } label: {
            ZStack {
                RoundedRectangle(cornerRadius: VRadius.md)
                    .fill(Color.black.opacity(0.8))
                    .frame(height: 200)

                Image(systemName: "play.circle.fill")
                    .font(.system(size: 48))
                    .foregroundColor(.white.opacity(0.9))
            }
        }
        .buttonStyle(.plain)
    }

    private var videoWebView: some View {
        VideoEmbedWebView(
            url: embedURL,
            onLoaded: { stateManager.didStartPlaying() },
            onFailed: { stateManager.didFail($0) }
        )
        .frame(height: 200)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
    }

    private func failedView(_ message: String) -> some View {
        VStack(spacing: VSpacing.sm) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 24))
                .foregroundColor(VColor.textMuted)
            Text("Failed to load video")
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
            Button("Open in Safari") {
                UIApplication.shared.open(embedURL)
            }
            .font(VFont.caption)
        }
        .frame(height: 200)
        .frame(maxWidth: .infinity)
        .background(Color.black.opacity(0.8))
    }
}

/// UIViewRepresentable wrapper for WKWebView to play video embeds.
private struct VideoEmbedWebView: UIViewRepresentable {
    let url: URL
    let onLoaded: () -> Void
    let onFailed: (String) -> Void

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.isScrollEnabled = false
        webView.navigationDelegate = context.coordinator
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(onLoaded: onLoaded, onFailed: onFailed)
    }

    class Coordinator: NSObject, WKNavigationDelegate {
        let onLoaded: () -> Void
        let onFailed: (String) -> Void

        init(onLoaded: @escaping () -> Void, onFailed: @escaping (String) -> Void) {
            self.onLoaded = onLoaded
            self.onFailed = onFailed
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            onLoaded()
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            onFailed(error.localizedDescription)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            onFailed(error.localizedDescription)
        }
    }
}
#endif
