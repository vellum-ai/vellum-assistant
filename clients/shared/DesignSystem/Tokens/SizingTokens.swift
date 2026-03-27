import Foundation

/// Component sizing tokens for consistent dimensions across the design system.
///
/// Use these instead of hardcoded values for icon sizes, row heights, and slot frames.
public enum VSize {
    // MARK: - Icons

    /// Default icon render size used in sidebar rows, menu items, and split buttons (13pt).
    public static let iconDefault: CGFloat = 13

    /// Frame size for the leading icon slot in rows — all icons occupy a uniform square frame (20pt).
    public static let iconSlot: CGFloat = 20

    // MARK: - Rows

    /// Minimum row height for interactive list/menu rows to ensure accessible tap targets (32pt).
    public static let rowMinHeight: CGFloat = 32
}
