import Foundation
import Testing
import VellumAssistantShared
@testable import VellumAssistantLib

@Suite("Chat safe-storage cleanup banner")
struct ChatDiskPressureBannerTests {
    @Test
    func cleanupStatusRequiresAcknowledgedLockedStatus() {
        #expect(SafeStorageCleanupStatusViewState(
            status: Self.status(acknowledged: false),
            isCleanupModeActive: false
        ) == nil)

        let state = SafeStorageCleanupStatusViewState(
            status: Self.status(acknowledged: true),
            isCleanupModeActive: true
        )

        #expect(state?.usageText == "Storage is 97% full at /workspace. Critical threshold is 95%.")
        #expect(state?.blockedCapabilityLabels.contains("Background processes disabled") == true)
        #expect(state?.blockedCapabilityLabels.contains("Trusted-contact messages blocked") == true)
    }

    @Test
    func cleanupStatusCopyExplainsBlockedWorkUntilGuardianFreesSpace() {
        let state = SafeStorageCleanupStatusViewState(
            status: Self.status(acknowledged: true),
            isCleanupModeActive: true
        )

        #expect(state?.summaryText.contains("Background processes are disabled until enough space is freed by the guardian.") == true)
        #expect(state?.summaryText.contains("Messages from trusted contacts are blocked until enough space is freed by the guardian.") == true)
    }

    @Test @MainActor
    func cleanupActionRequestsWorkspaceLanding() {
        let windowState = MainWindowState()

        windowState.showWorkspace()

        #expect(windowState.selection == .panel(.intelligence))
        #expect(windowState.pendingIntelligenceTab == "Workspace")
    }

    private static func status(
        acknowledged: Bool,
        enabled: Bool = true,
        locked: Bool = true,
        effectivelyLocked: Bool = true
    ) -> DiskPressureStatus {
        DiskPressureStatus(
            enabled: enabled,
            state: enabled ? "critical" : "disabled",
            locked: locked,
            acknowledged: acknowledged,
            overrideActive: false,
            effectivelyLocked: effectivelyLocked,
            lockId: "disk-pressure-test",
            usagePercent: 97,
            thresholdPercent: 95,
            path: "/workspace",
            lastCheckedAt: "2026-05-05T12:00:00.000Z",
            blockedCapabilities: ["agent-turns", "background-work", "remote-ingress"],
            error: nil
        )
    }
}
