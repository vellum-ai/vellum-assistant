import AppKit
import SwiftUI
import VellumAssistantShared

/// Reusable thumbnail view that renders a source preview with proper
/// fallback states for all `PreviewStatus` values.
///
/// Used in both the per-row thumbnails (80x50pt) and the larger preview
/// pane (fills available width, ~160pt tall). Pass the desired `size`
/// to control dimensions.
struct ThumbnailView: View {
    let thumbnail: NSImage?
    let previewStatus: PreviewStatus
    let size: CGSize

    /// Drives the loading skeleton pulse animation.
    @State private var isPulsing = false

    var body: some View {
        Group {
            switch previewStatus {
            case .idle:
                placeholder

            case .loading:
                loadingSkeleton

            case .loaded:
                if let thumbnail {
                    Image(nsImage: thumbnail)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(width: size.width, height: size.height)
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                } else {
                    // Loaded but no thumbnail (shouldn't happen, but handle gracefully)
                    placeholder
                }

            case .failed:
                failedState
            }
        }
        .frame(width: size.width, height: size.height)
        .onChange(of: previewStatus) { _, newValue in
            if newValue != .loading {
                isPulsing = false
            }
        }
    }

    // MARK: - Substates

    private var placeholder: some View {
        RoundedRectangle(cornerRadius: VRadius.sm)
            .fill(VColor.surfaceBase)
            .frame(width: size.width, height: size.height)
    }

    private var loadingSkeleton: some View {
        RoundedRectangle(cornerRadius: VRadius.sm)
            .fill(VColor.surfaceBase)
            .frame(width: size.width, height: size.height)
            .opacity(isPulsing ? 0.4 : 1.0)
            .onAppear {
                withAnimation(
                    VAnimation.standard.repeatForever(autoreverses: true)
                ) {
                    isPulsing = true
                }
            }
    }

    private var failedState: some View {
        VStack(spacing: VSpacing.xs) {
            VIconView(.squareDashed, size: min(size.width, size.height) * 0.3)
                .foregroundColor(VColor.contentTertiary)
            if size.height >= 50 {
                Text("Preview unavailable")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
                    .lineLimit(1)
            }
        }
        .frame(width: size.width, height: size.height)
        .background(
            RoundedRectangle(cornerRadius: VRadius.sm)
                .fill(VColor.surfaceBase)
        )
    }
}
