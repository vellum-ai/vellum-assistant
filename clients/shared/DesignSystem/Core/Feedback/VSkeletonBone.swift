import SwiftUI

/// Atomic skeleton placeholder — a rounded rectangle with shimmer animation.
/// Use as a stand-in for text lines, avatars, or UI elements during loading.
public struct VSkeletonBone: View {
    public var width: CGFloat?
    public var height: CGFloat
    public var radius: CGFloat

    public init(width: CGFloat? = nil, height: CGFloat = 14, radius: CGFloat = VRadius.sm) {
        self.width = width
        self.height = height
        self.radius = radius
    }

    public var body: some View {
        RoundedRectangle(cornerRadius: radius)
            .fill(VColor.borderBase.opacity(0.5))
            .frame(width: width, height: height)
            .vShimmer()
    }
}

