import SwiftUI

/// Arranges content horizontally when space allows, falling back to vertical stacking.
///
/// Uses `ViewThatFits` to select between an `HStack` (preferred at wider widths)
/// and `VStack` (compact fallback) based on available horizontal space. This avoids
/// manual breakpoint calculations and follows Apple's recommended adaptive layout API.
///
/// - Note: `ViewThatFits` evaluates the content closure for both the `HStack`
///   and `VStack` branches to measure which fits. For lightweight views (labels,
///   buttons, dropdowns) this is negligible, but avoid placing views with expensive
///   initialization or side effects inside the closure.
///
/// Usage:
///
///     VAdaptiveStack {
///         VDropdown(placeholder: "Model", selection: $model, options: models)
///         VButton(label: "Save", style: .primary) { save() }
///     }
///
public struct VAdaptiveStack<Content: View>: View {
    public let horizontalAlignment: VerticalAlignment
    public let verticalAlignment: HorizontalAlignment
    public let spacing: CGFloat
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
