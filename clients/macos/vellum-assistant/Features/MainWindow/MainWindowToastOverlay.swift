import SwiftUI
import VellumAssistantShared

/// Standalone view for the window toast overlay, creating a SwiftUI
/// invalidation boundary so changes to unrelated `@ObservedObject`s on
/// `MainWindowView` don't force this overlay to re-evaluate.
struct MainWindowToastOverlay: View {
    @ObservedObject var windowState: MainWindowState

    var body: some View {
        if let toast = windowState.toastInfo {
            VToast(
                message: toast.message,
                style: toast.style == .success ? .success : toast.style == .warning ? .warning : .error,
                copyableDetail: toast.copyableDetail,
                primaryAction: toast.primaryAction,
                onDismiss: { windowState.dismissToast() }
            )
            .padding(.horizontal, VSpacing.xl)
            .padding(.bottom, VSpacing.xl)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }
}
