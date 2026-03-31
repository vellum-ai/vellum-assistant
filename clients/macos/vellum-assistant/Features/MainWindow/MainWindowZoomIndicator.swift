import SwiftUI
import VellumAssistantShared

/// Standalone view for the zoom indicator overlay, creating a SwiftUI
/// invalidation boundary so changes to unrelated `@ObservedObject`s on
/// `MainWindowView` don't force this overlay to re-evaluate.
struct MainWindowZoomIndicator: View {
    let showZoomIndicator: Bool
    let zoomPercentage: Int

    var body: some View {
        if showZoomIndicator {
            ZoomIndicatorView(percentage: zoomPercentage)
                .transition(.move(edge: .top).combined(with: .opacity))
                .padding(.top, 40)
                .shadow(color: VColor.auxBlack.opacity(0.15), radius: 8, y: 2)
        }
    }
}
