import Foundation

/// Spacing scale based on 4pt grid.
/// Usage: `.padding(VSpacing.lg)` or `.padding(.horizontal, VSpacing.xl)`
public enum VSpacing {
    public static let xxs: CGFloat  = 2
    public static let xs: CGFloat   = 4
    public static let sm: CGFloat   = 8
    public static let md: CGFloat   = 12
    public static let lg: CGFloat   = 16
    public static let xl: CGFloat   = 24
    public static let xxl: CGFloat  = 32
    public static let xxxl: CGFloat = 48

    // MARK: - Semantic Aliases

    /// Standard gap between inline elements (icons + text, etc.)
    public static let inline: CGFloat = sm
    /// Standard content padding inside cards and panels
    public static let content: CGFloat = lg
    /// Standard section gap between major UI blocks
    public static let section: CGFloat = xl
    /// Standard window/page-level margin
    public static let page: CGFloat = xxl
    /// Compact vertical padding for buttons
    public static let buttonV: CGFloat = 5.5
}
