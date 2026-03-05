import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

final class SidebarLayoutMetricsTests: XCTestCase {

    // MARK: - Icon Slot

    func testIconSlotIsSquare() {
        // All sidebar rows use a uniform square icon slot.
        XCTAssertEqual(SidebarLayoutMetrics.iconSlotSize, 20)
    }

    // MARK: - Row Height

    func testRowMinHeightIsAccessible() {
        // Minimum row height must be at least 28pt for comfortable click targets.
        XCTAssertGreaterThanOrEqual(SidebarLayoutMetrics.rowMinHeight, 28)
    }

    func testRowVerticalPaddingIsCompact() {
        // Compact density: vertical padding should be 4pt (VSpacing.xs).
        XCTAssertEqual(SidebarLayoutMetrics.rowVerticalPadding, 4)
    }

    // MARK: - Divider

    func testDividerVerticalPaddingMatchesCompact() {
        // Both expanded and collapsed modes use the same compact divider spacing.
        XCTAssertEqual(SidebarLayoutMetrics.dividerVerticalPadding, 4)
    }

    func testDividerHorizontalPaddingExpandedIsWider() {
        XCTAssertGreaterThan(
            SidebarLayoutMetrics.dividerHorizontalPaddingExpanded,
            SidebarLayoutMetrics.dividerHorizontalPaddingCollapsed
        )
    }

    // MARK: - List Row Spacing

    func testListRowGapMatchesNavRhythm() {
        // Thread row gap should match nav/pinned VStack spacing (VSpacing.sm = 8pt).
        XCTAssertEqual(SidebarLayoutMetrics.listRowGap, 8)
    }

    // MARK: - Section Title

    func testSectionTitleTopGapIsTight() {
        XCTAssertLessThanOrEqual(SidebarLayoutMetrics.sectionTitleTopGap, SidebarLayoutMetrics.dividerVerticalPadding)
    }

    func testSectionTitleBottomGapIsPositive() {
        XCTAssertGreaterThan(SidebarLayoutMetrics.sectionTitleBottomGap, 0)
    }

    // MARK: - Scheduled Section

    func testScheduledHeaderGapsArePositive() {
        XCTAssertGreaterThan(SidebarLayoutMetrics.scheduledHeaderTopGap, 0)
        XCTAssertGreaterThan(SidebarLayoutMetrics.scheduledHeaderBottomGap, 0)
    }
}
