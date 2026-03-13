import SwiftUI
import VellumAssistantShared

/// Canonical layout metrics shared across all sidebar row types (nav, pinned app, thread)
/// and section dividers. Centralises ad-hoc spacing literals so row density and section
/// rhythm stay consistent between expanded and collapsed modes.
enum SidebarLayoutMetrics {
    // MARK: - Row Metrics

    /// Icon slot size — all leading icons occupy a uniform 20×20 frame.
    static let iconSlotSize: CGFloat = 20

    /// Vertical padding inside each row (above and below content).
    static let rowVerticalPadding: CGFloat = VSpacing.xs  // 4pt — compact density

    /// Minimum row height to ensure touch/click targets remain accessible.
    static let rowMinHeight: CGFloat = 32

    // MARK: - List Row Spacing

    /// Gap between consecutive thread/scheduled rows — matches nav/pinned VStack spacing.
    static let listRowGap: CGFloat = VSpacing.xs  // 4pt

    // MARK: - Section Title

    /// Gap above a section title (e.g. "Threads", "Scheduled") — tighter than divider bottom.
    static let sectionTitleTopGap: CGFloat = VSpacing.xxs  // 2pt

    /// Gap below a section title before the first row.
    static let sectionTitleBottomGap: CGFloat = VSpacing.xs  // 4pt

    // MARK: - Scheduled Section

    /// Gap above the "Scheduled" label.
    static let scheduledHeaderTopGap: CGFloat = VSpacing.sm  // 8pt

    /// Gap below the "Scheduled" label before the first scheduled row.
    static let scheduledHeaderBottomGap: CGFloat = VSpacing.xs  // 4pt

    // MARK: - Archive Confirm

    /// Trailing padding reserved for the "Confirm" pill button overlay during archive flow.
    static let archiveConfirmTrailingPadding: CGFloat = 72

    // MARK: - Section Divider

    /// Vertical padding above and below a section divider line.
    static let dividerVerticalPadding: CGFloat = VSpacing.xs  // 4pt — compact rhythm

    /// Horizontal inset for dividers in expanded mode.
    static let dividerHorizontalPaddingExpanded: CGFloat = VSpacing.md  // 12pt

    /// Horizontal inset for dividers in collapsed mode.
    static let dividerHorizontalPaddingCollapsed: CGFloat = VSpacing.xs  // 4pt
}
