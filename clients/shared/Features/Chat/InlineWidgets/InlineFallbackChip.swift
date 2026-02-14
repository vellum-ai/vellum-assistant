import SwiftUI

/// Fallback view for unsupported inline surface types.
public struct InlineFallbackChip: View {
    public let surfaceType: SurfaceType

    public init(surfaceType: SurfaceType) {
        self.surfaceType = surfaceType
    }

    public var body: some View {
        HStack(spacing: VSpacing.sm) {
            Image(systemName: "square.on.square")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)

            Text("Interactive \(surfaceType.rawValue) surface")
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
        }
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.sm)
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.backgroundSubtle.opacity(0.5))
        )
    }
}
