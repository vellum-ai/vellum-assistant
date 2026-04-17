import SwiftUI
import VellumAssistantShared

/// Pill-shaped row displaying a file reference with icon, file name,
/// and size. Used inside recap cards to show linked attachments.
struct HomeLinkFileRow: View {

    /// Visual style for the row's capsule background.
    ///
    /// - `solid`: opaque `surfaceOverlay` fill for use inside an outer
    ///   card container (e.g. `HomeFileCard`) where the row should read
    ///   as a nested surface.
    /// - `glass`: translucent material + tint for use directly on the
    ///   page background, matching the glassmorphic treatment applied
    ///   to stacked recap pills (e.g. `HomeAuthCard` rich variant).
    enum Style {
        case solid
        case glass
    }

    let icon: VIcon
    let fileName: String
    let fileSize: String
    var style: Style = .solid

    var body: some View {
        pill
    }

    /// Renders the pill and applies the glass-style shadow when needed.
    /// The shadow is what defines the pill edge on flat near-white
    /// backdrops where the `auxWhite @ 10%` tint alone is invisible.
    @ViewBuilder
    private var pill: some View {
        let base = HStack(spacing: VSpacing.sm) {
            iconCircle

            VStack(alignment: .leading, spacing: 0) {
                Text(fileName)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(1)

                Text(fileSize)
                    .font(VFont.labelSmall)
                    .foregroundStyle(VColor.contentTertiary)
                    .lineLimit(1)
            }
        }
        .padding(EdgeInsets(top: 2, leading: 2, bottom: 2, trailing: VSpacing.lg))
        .background(backgroundShape)
        .clipShape(Capsule())

        switch style {
        case .solid:
            base
        case .glass:
            base.vShadow(VShadow.md)
        }
    }

    // MARK: - Background

    /// Apple's canonical glassmorphic recipe is a translucent `Material`
    /// for the blurred backdrop, optionally layered with a tint to match
    /// the Figma `FFFFFF @ 10%` fill. `Material` adapts automatically to
    /// the current appearance, so the same treatment reads correctly in
    /// both light and dark mode without conditional logic.
    /// Reference: https://developer.apple.com/documentation/swiftui/material
    @ViewBuilder
    private var backgroundShape: some View {
        switch style {
        case .solid:
            Capsule().fill(VColor.surfaceOverlay)
        case .glass:
            Capsule()
                .fill(.ultraThinMaterial)
                .overlay(
                    Capsule().fill(VColor.auxWhite.opacity(0.1))
                )
        }
    }

    // MARK: - Icon circle

    /// 26pt circular container with active surface background.
    private var iconCircle: some View {
        ZStack {
            Circle()
                .fill(VColor.surfaceActive)
                .frame(width: 26, height: 26)

            VIconView(icon, size: 12)
                .foregroundStyle(VColor.contentSecondary)
        }
    }
}
