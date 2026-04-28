import Testing
@testable import VellumAssistantLib

@Suite("Settings General disk resources section")
struct SettingsGeneralDiskSectionTests {
    @Test
    func diskMetricsMakeResourceSectionEligible() {
        let healthz = DaemonHealthz(
            status: "ok",
            disk: DaemonHealthz.DiskInfo(
                path: "/workspace",
                totalMb: 10_000,
                usedMb: 9_250,
                freeMb: 750
            )
        )

        #expect(SettingsGeneralTab.hasResourceMetrics(healthz))
    }

    @Test
    func assistantsWithoutMetricsAreNotTreatedAsResourceEligible() {
        #expect(!SettingsGeneralTab.hasResourceMetrics(nil))
        #expect(!SettingsGeneralTab.hasResourceMetrics(DaemonHealthz(status: "ok")))
    }

    @Test
    func localAssistantsDoNotShowResourcesBeforeMetricsLoad() {
        #expect(!SettingsGeneralTab.shouldShowSystemResourcesSection(
            topology: .local,
            healthz: nil,
            pendingSection: nil
        ))
    }

    @Test
    func explicitDeepLinkShowsResourcesWhileLoading() {
        #expect(SettingsGeneralTab.shouldShowSystemResourcesSection(
            topology: .local,
            healthz: nil,
            pendingSection: .systemResources
        ))
    }

    @Test
    func rememberedDeepLinkKeepsResourcesVisibleAfterPendingSectionClears() {
        #expect(SettingsGeneralTab.shouldShowSystemResourcesSection(
            topology: .local,
            healthz: nil,
            pendingSection: nil,
            deepLinkRequestPending: true
        ))
    }

    @Test
    func completedDeepLinkDoesNotKeepResourcesVisibleWithoutMetrics() {
        #expect(!SettingsGeneralTab.shouldShowSystemResourcesSection(
            topology: .local,
            healthz: nil,
            pendingSection: nil,
            deepLinkRequestPending: false
        ))
    }

    @Test
    func megabyteFormatterUsesReadableUnits() {
        #expect(SettingsGeneralTab.formatMb(512) == "512 MB")
        #expect(SettingsGeneralTab.formatMb(1_536) == "1.5 GB")
    }
}
