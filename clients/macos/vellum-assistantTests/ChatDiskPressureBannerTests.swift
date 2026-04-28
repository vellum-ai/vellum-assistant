import Testing
@testable import VellumAssistantLib

@Suite("Chat disk-pressure banner")
struct ChatDiskPressureBannerTests {
    @Test
    func subtitleUsesMonitorDisplayPercent() {
        let alert = DiskPressureAlert(
            id: "disk-pressure:assistant-123:1",
            assistantId: "assistant-123",
            displayPercent: 93,
            usedMb: 930,
            totalMb: 1_000
        )

        #expect(DiskPressureBanner.subtitle(for: alert) == "Storage is 93% full.")
    }

    @Test @MainActor
    func reviewDiskUsageRequestsGeneralStorageLanding() {
        let store = SettingsStore()

        store.requestGeneralSection(.systemResources)

        #expect(store.pendingSettingsTab == .general)
        #expect(store.pendingSettingsGeneralSection == .systemResources)
    }
}
