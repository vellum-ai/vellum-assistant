import SwiftUI

/// Compact chip shown for a completed inline surface, displaying a checkmark and summary.
public struct CompletedSurfaceChip: View {
    public let title: String?
    public let summary: String

    public init(title: String?, summary: String) {
        self.title = title
        self.summary = summary
    }

    public var body: some View {
        HStack(spacing: VSpacing.sm) {
            VIconView(.circleCheck, size: 12)
                .foregroundColor(VColor.systemPositiveStrong)

            if let title {
                Text(title)
                    .font(VFont.captionMedium)
                    .foregroundColor(VColor.contentDefault)
            }

            Text(summary)
                .font(VFont.caption)
                .foregroundColor(VColor.contentSecondary)
        }
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.sm)
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.surfaceOverlay.opacity(0.5))
        )
    }
}
