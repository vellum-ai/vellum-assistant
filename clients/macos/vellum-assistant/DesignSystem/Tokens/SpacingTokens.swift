import Foundation

/// Spacing scale based on 4pt grid.
/// Usage: `.padding(VSpacing.lg)` or `.padding(.horizontal, VSpacing.xl)`
enum VSpacing {
    static let xxs: CGFloat  = 2
    static let xs: CGFloat   = 4
    static let sm: CGFloat   = 8
    static let md: CGFloat   = 12
    static let lg: CGFloat   = 16
    static let xl: CGFloat   = 24
    static let xxl: CGFloat  = 32
    static let xxxl: CGFloat = 48

    // MARK: - Semantic Aliases

    /// Standard gap between inline elements (icons + text, etc.)
    static let inline: CGFloat = sm
    /// Standard content padding inside cards and panels
    static let content: CGFloat = lg
    /// Standard section gap between major UI blocks
    static let section: CGFloat = xl
    /// Standard window/page-level margin
    static let page: CGFloat = xxl
    /// Compact vertical padding for buttons
    static let buttonV: CGFloat = 5.5
}
