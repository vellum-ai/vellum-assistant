import SwiftUI
import VellumAssistantShared

/// Container view for the Home Base tab that checks for a custom desktop interface.
/// When `data/interfaces/vellum-desktop/index.html` exists on the daemon, renders
/// it in a WebView via `DynamicPageSurfaceView`. Otherwise falls back to the
/// existing `AppDirectoryView`.
struct HomeBaseContainerView: View {
    let daemonClient: DaemonClient
    let onBack: () -> Void
    let onOpenApp: (UiSurfaceShowMessage) -> Void
    var onRecordAppOpen: ((_ id: String, _ name: String, _ icon: String?, _ appType: String?) -> Void)?
    var onPinApp: ((_ id: String, _ name: String, _ icon: String?, _ appType: String?) -> Void)?

    private enum ViewState {
        case loading
        case customInterface(String)
        case fallback
    }

    @State private var viewState: ViewState = .loading
    @State private var fetchTask: Task<Void, Never>?

    var body: some View {
        Group {
            switch viewState {
            case .loading:
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(VColor.background)
            case .customInterface(let html):
                DynamicPageSurfaceView(
                    data: DynamicPageSurfaceData(html: html),
                    onAction: { _, _ in }
                )
            case .fallback:
                AppDirectoryView(
                    daemonClient: daemonClient,
                    onBack: onBack,
                    onOpenApp: onOpenApp,
                    onRecordAppOpen: onRecordAppOpen,
                    onPinApp: onPinApp
                )
            }
        }
        .onAppear {
            fetchDesktopInterface()
        }
        .onDisappear {
            fetchTask?.cancel()
        }
    }

    private func fetchDesktopInterface() {
        fetchTask = Task {
            let html = await daemonClient.fetchInterfaceFile(path: "vellum-desktop/index.html")
            guard !Task.isCancelled else { return }
            if let html, !html.isEmpty {
                viewState = .customInterface(html)
            } else {
                viewState = .fallback
            }
        }
    }
}
