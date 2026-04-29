import Testing
@testable import VellumAssistantLib

@Suite("Chat disk-pressure banner")
struct ChatDiskPressureBannerTests {
    @Test
    func titleStartsWithDiskEmoji() {
        #expect(DiskPressureBanner.title == "💾 It looks like you're running out of disk space.")
    }

    @Test
    func subtitleUsesMonitorDisplayPercent() {
        let alert = DiskPressureAlert(
            id: "disk-pressure:assistant-123:1",
            assistantId: "assistant-123",
            displayPercent: 93
        )

        #expect(DiskPressureBanner.subtitle(for: alert) == "Storage is 93% full. Try cleaning up unused data, like logs.")
    }

    @Test @MainActor
    func reviewDiskUsageRequestsWorkspaceLanding() {
        let windowState = MainWindowState()

        windowState.showWorkspace()

        #expect(windowState.selection == .panel(.intelligence))
        #expect(windowState.pendingIntelligenceTab == "Workspace")
    }
}
