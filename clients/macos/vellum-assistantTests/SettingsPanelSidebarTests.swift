import XCTest
@testable import VellumAssistantLib

final class SettingsPanelSidebarTests: XCTestCase {

    func testCompactionPlaygroundAppearsFirstInTopSidebarWhenAllGatesEnabled() {
        let includePlayground = SettingsTab.isCompactionPlaygroundVisible(
            developerEnabled: true,
            playgroundEnabled: true,
            devModeEnabled: true
        )

        let tabs = SettingsTab.sidebarTopTabs(includeCompactionPlayground: includePlayground)

        XCTAssertEqual(tabs.first, .compactionPlayground)
        XCTAssertEqual(tabs.dropFirst().first, .general)
    }

    func testCompactionPlaygroundIsOmittedWhenFeatureFlagDisabled() {
        let includePlayground = SettingsTab.isCompactionPlaygroundVisible(
            developerEnabled: true,
            playgroundEnabled: false,
            devModeEnabled: true
        )

        let tabs = SettingsTab.sidebarTopTabs(includeCompactionPlayground: includePlayground)

        XCTAssertFalse(tabs.contains(.compactionPlayground))
        XCTAssertEqual(tabs.first, .general)
    }

    func testCompactionPlaygroundIsOmittedWhenDeveloperNavDisabled() {
        let includePlayground = SettingsTab.isCompactionPlaygroundVisible(
            developerEnabled: false,
            playgroundEnabled: true,
            devModeEnabled: true
        )

        let tabs = SettingsTab.sidebarTopTabs(includeCompactionPlayground: includePlayground)

        XCTAssertFalse(tabs.contains(.compactionPlayground))
    }

    func testCompactionPlaygroundIsOmittedWhenDevModeDisabled() {
        let includePlayground = SettingsTab.isCompactionPlaygroundVisible(
            developerEnabled: true,
            playgroundEnabled: true,
            devModeEnabled: false
        )

        let tabs = SettingsTab.sidebarTopTabs(includeCompactionPlayground: includePlayground)

        XCTAssertFalse(tabs.contains(.compactionPlayground))
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
