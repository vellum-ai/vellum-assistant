import SwiftUI
import VellumAssistantShared

/// Pill-shaped row displaying a file reference with icon, file name,
/// and size. Used inside recap cards to show linked attachments.
struct HomeLinkFileRow: View {
    let icon: VIcon
    let fileName: String
    let fileSize: String

    var body: some View {
        HStack(spacing: VSpacing.sm) {
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
        .background(
            Capsule()
                .fill(VColor.surfaceOverlay)
        )
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
