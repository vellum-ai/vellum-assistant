import SwiftUI

/// Fallback view for unsupported inline surface types.
public struct InlineFallbackChip: View {
    public let surfaceType: SurfaceType

    public init(surfaceType: SurfaceType) {
        self.surfaceType = surfaceType
    }

    public var body: some View {
        HStack(spacing: VSpacing.sm) {
            VIconView(.layers, size: 12)
                .foregroundColor(VColor.contentTertiary)

            Text("Interactive \(surfaceType.rawValue) surface")
                .font(VFont.caption)
                .foregroundColor(VColor.contentSecondary)
        }
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.sm)
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.surfaceBase.opacity(0.5))
        )
    }
}
