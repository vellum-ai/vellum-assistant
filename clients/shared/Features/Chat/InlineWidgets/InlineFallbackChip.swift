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
                .foregroundStyle(VColor.contentTertiary)

            Text("Interactive \(surfaceType.rawValue) surface")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)
        }
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.sm)
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.surfaceOverlay.opacity(0.5))
        )
    }
}
