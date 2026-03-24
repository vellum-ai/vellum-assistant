import SwiftUI

/// A colored tag for categorizing items. Unlike `VBadge` (which conveys status
/// or counts), `VTag` labels an item's *kind* using a pastel background derived
/// from the tag's color.
///
/// Figma spec: 6 pt corner radius, 8 pt horizontal / 4 pt vertical padding,
/// DM Sans SemiBold 12 pt text, optional leading icon, optional trailing chevron.
public struct VTag: View {
    public let label: String
    public var color: Color
    public var icon: VIcon?

    /// Creates a tag with a pastel background derived from `color`.
    public init(_ label: String, color: Color, icon: VIcon? = nil) {
        self.label = label
        self.color = color
        self.icon = icon
    }

    public var body: some View {
        HStack(spacing: VSpacing.xs) {
            if let icon {
                VIconView(icon, size: 12)
                    .foregroundStyle(color)
            }
            Text(label)
                .font(VFont.bodySmallEmphasised)
                .foregroundStyle(VColor.contentDefault)
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xs)
        .background(color.opacity(0.2))
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .accessibilityLabel(label)
    }
}
