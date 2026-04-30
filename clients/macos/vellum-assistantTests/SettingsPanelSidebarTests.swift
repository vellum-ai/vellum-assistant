import XCTest
@testable import VellumAssistantLib

final class SettingsPanelSidebarTests: XCTestCase {

    func testCompactionPlaygroundAppearsBeforeGeneralWhenIncluded() {
        let tabs = SettingsTab.sidebarTopTabs(includeCompactionPlayground: true)

        XCTAssertEqual(tabs.first, .compactionPlayground)
        XCTAssertEqual(tabs.dropFirst().first, .general)
    }

    func testCompactionPlaygroundIsOmittedWhenExcluded() {
        let tabs = SettingsTab.sidebarTopTabs(includeCompactionPlayground: false)

        XCTAssertFalse(tabs.contains(.compactionPlayground))
        XCTAssertEqual(tabs.first, .general)
    }

    func testDeveloperIsNotRenderedInTopSidebarGroup() {
        let topTabs = SettingsTab.sidebarTopTabs(includeCompactionPlayground: true)

        XCTAssertFalse(topTabs.contains(.developer))
    }

}
