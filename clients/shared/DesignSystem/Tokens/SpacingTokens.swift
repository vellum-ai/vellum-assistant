import Foundation
#if os(iOS)
import UIKit
#endif

/// Spacing scale based on 4pt grid.
/// Usage: `.padding(VSpacing.lg)` or `.padding(.horizontal, VSpacing.xl)`
public enum VSpacing {

    private static var isPhone: Bool {
        #if os(iOS)
        return UIDevice.current.userInterfaceIdiom == .phone
        #else
        return false
        #endif
    }

    public static let xxs: CGFloat  = 2
    public static let xs: CGFloat   = 4
    public static let sm: CGFloat   = 8
    public static let md: CGFloat   = 12
    public static let lg: CGFloat   = 16
    public static let xl: CGFloat   = 24

    public static var xxl: CGFloat  { isPhone ? 24 : 32 }
    public static var xxxl: CGFloat { isPhone ? 40 : 48 }

    // MARK: - Semantic Aliases

    /// Standard gap between inline elements (icons + text, etc.)
    public static let inline: CGFloat = sm
    /// Standard content padding inside cards and panels
    public static let content: CGFloat = lg
    /// Standard section gap between major UI blocks
    public static var section: CGFloat { isPhone ? 20 : xl }
    /// Standard window/page-level margin
    public static var page: CGFloat { xxl }
    /// Compact vertical padding for buttons
    public static let buttonV: CGFloat = 5.5

    // MARK: - Layout Constraints

    /// Maximum width for chat message bubbles
    public static let chatBubbleMaxWidth: CGFloat = 680
    /// Maximum width for the chat message column (bubble width + horizontal padding)
    public static let chatColumnMaxWidth: CGFloat = chatBubbleMaxWidth + 2 * xl
}
