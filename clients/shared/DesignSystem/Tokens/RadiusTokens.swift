import Foundation

/// Corner radius scale. Use `VRadius.pill` for capsule shapes.
public enum VRadius {
    public static let xs: CGFloat  = 2
    public static let sm: CGFloat  = 4
    public static let md: CGFloat  = 8
    public static let lg: CGFloat  = 12
    public static let xl: CGFloat  = 16
    public static let xxl: CGFloat = 20

    /// 6pt radius for chip/tag/badge-style components. Sits between `sm`
    /// (4pt) and `md` (8pt); use when neither t-shirt step matches.
    public static let chip: CGFloat = 6

    /// Matches the macOS NSWindow corner radius (~10pt on Ventura+).
    /// Use when clipping content to align with the system window chrome.
    public static let window: CGFloat = 10

    /// Use for fully rounded pill/capsule shapes
    public static let pill: CGFloat = 999
}
