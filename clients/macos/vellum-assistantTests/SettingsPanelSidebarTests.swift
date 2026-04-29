import XCTest
@testable import VellumAssistantLib

final class SettingsPanelSidebarTests: XCTestCase {

    func testCompactionPlaygroundPositionFollowsVisibilityGate() {
        let cases: [(visibility: SettingsTab.SidebarVisibility, expectedVisible: Bool)] = [
            (.init(developerEnabled: true, compactionPlaygroundEnabled: true, devModeEnabled: true), true),
            (.init(developerEnabled: true, compactionPlaygroundEnabled: false, devModeEnabled: true), false),
            (.init(developerEnabled: false, compactionPlaygroundEnabled: true, devModeEnabled: true), false),
            (.init(developerEnabled: true, compactionPlaygroundEnabled: true, devModeEnabled: false), false)
        ]

        for testCase in cases {
            let tabs = SettingsTab.sidebarTopTabs(visibility: testCase.visibility)

            XCTAssertEqual(tabs.contains(.compactionPlayground), testCase.expectedVisible)
            if testCase.expectedVisible {
                XCTAssertEqual(tabs.first, .compactionPlayground)
                XCTAssertEqual(tabs.dropFirst().first, .general)
            } else {
                XCTAssertEqual(tabs.first, .general)
            }
        }
    }

    func testDeveloperIsNotRenderedInTopSidebarGroup() {
        let topTabs = SettingsTab.sidebarTopTabs(
            visibility: .init(developerEnabled: true, compactionPlaygroundEnabled: true, devModeEnabled: true)
        )

        XCTAssertFalse(topTabs.contains(.developer))
    }

    func testDeferredDeepLinksAreLimitedToAsyncGatedTabs() {
        XCTAssertTrue(SettingsTab.canDeferDeepLink(.developer))
        XCTAssertTrue(SettingsTab.canDeferDeepLink(.compactionPlayground))
        XCTAssertFalse(SettingsTab.canDeferDeepLink(.billing))
        XCTAssertFalse(SettingsTab.canDeferDeepLink(.sounds))
    }
}
