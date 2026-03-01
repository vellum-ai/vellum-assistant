import SwiftUI
@preconcurrency import WebKit
import VellumAssistantShared

/// Renders the brain-graph visualization (2D D3 + 3D Three.js) served by the
/// local daemon runtime at /v1/brain-graph-ui.
struct BrainGraphView: View {
    @ObservedObject var daemonClient: DaemonClient

    var body: some View {
        if let port = daemonClient.httpPort {
            BrainWebViewRepresentable(port: port)
                .transition(.opacity)
        } else {
            VStack(spacing: VSpacing.md) {
                ProgressView()
                    .scaleEffect(0.8)
                Text("Connecting…")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(VColor.background)
        }
    }
}

// MARK: - WKWebView wrapper

private struct BrainWebViewRepresentable: NSViewRepresentable {
    let port: Int

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.setValue(false, forKey: "drawsBackground")
        webView.layer?.backgroundColor = .clear
        load(into: webView)
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        // Port shouldn't change after daemon connects, but guard anyway
        let expected = "http://localhost:\(port)/v1/brain-graph-ui"
        if webView.url?.absoluteString != expected {
            load(into: webView)
        }
    }

    private func load(into webView: WKWebView) {
        guard let url = URL(string: "http://localhost:\(port)/v1/brain-graph-ui") else { return }
        webView.load(URLRequest(url: url))
    }
}

#Preview {
    BrainGraphView(daemonClient: DaemonClient())
        .frame(width: 800, height: 600)
}
