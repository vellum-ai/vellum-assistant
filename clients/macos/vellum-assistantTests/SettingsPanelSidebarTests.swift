import XCTest
@testable import VellumAssistantLib

final class SettingsPanelSidebarTests: XCTestCase {

    func testCompactionPlaygroundPositionFollowsVisibilityGate() {
        let cases: [(developerEnabled: Bool, playgroundEnabled: Bool, devModeEnabled: Bool, expectedVisible: Bool)] = [
            (true, true, true, true),
            (true, false, true, false),
            (false, true, true, false),
            (true, true, false, false)
        ]

        for testCase in cases {
            let includePlayground = testCase.developerEnabled && testCase.playgroundEnabled && testCase.devModeEnabled
            let tabs = SettingsTab.sidebarTopTabs(includeCompactionPlayground: includePlayground)

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
        let topTabs = SettingsTab.sidebarTopTabs(includeCompactionPlayground: true)

        XCTAssertFalse(topTabs.contains(.developer))
    }

    func testDeferredDeepLinksAreLimitedToAsyncGatedTabs() {
        XCTAssertTrue(SettingsTab.canDeferDeepLink(.developer))
        XCTAssertTrue(SettingsTab.canDeferDeepLink(.compactionPlayground))
        XCTAssertFalse(SettingsTab.canDeferDeepLink(.billing))
        XCTAssertFalse(SettingsTab.canDeferDeepLink(.sounds))
    }
}
