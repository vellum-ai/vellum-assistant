import SwiftUI

/// Arranges content horizontally when space allows, falling back to vertical stacking.
///
/// Uses `ViewThatFits` to select between an `HStack` (preferred at wider widths)
/// and `VStack` (compact fallback) based on available horizontal space. This avoids
/// manual breakpoint calculations and follows Apple's recommended adaptive layout API.
///
/// Usage:
///
///     VAdaptiveStack {
///         VDropdown(placeholder: "Model", selection: $model, options: models)
///         VButton(label: "Save", style: .primary) { save() }
///     }
///
public struct VAdaptiveStack<Content: View>: View {
    public var horizontalAlignment: VerticalAlignment = .center
    public var verticalAlignment: HorizontalAlignment = .leading
    public var spacing: CGFloat = VSpacing.md
    @ViewBuilder public let content: () -> Content

    public init(
        horizontalAlignment: VerticalAlignment = .center,
        verticalAlignment: HorizontalAlignment = .leading,
        spacing: CGFloat = VSpacing.md,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.horizontalAlignment = horizontalAlignment
        self.verticalAlignment = verticalAlignment
        self.spacing = spacing
        self.content = content
    }

    public var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: horizontalAlignment, spacing: spacing) {
                content()
            }
            VStack(alignment: verticalAlignment, spacing: spacing) {
                content()
            }
        }
    }
}
