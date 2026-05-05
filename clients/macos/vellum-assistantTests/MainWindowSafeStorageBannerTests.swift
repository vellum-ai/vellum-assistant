import Foundation
import Testing
import VellumAssistantShared
@testable import VellumAssistantLib

@Suite("Main-window safe-storage acknowledgement banner")
struct MainWindowSafeStorageBannerTests {
    @Test
    func acknowledgementStateRequiresUnacknowledgedLockedStatus() {
        #expect(SafeStorageAcknowledgementViewState(
            status: Self.status(acknowledged: true),
            requiresAcknowledgement: false
        ) == nil)

        let state = SafeStorageAcknowledgementViewState(
            status: Self.status(acknowledged: false),
            requiresAcknowledgement: true
        )

        #expect(state?.usageText == "Storage is 97% full at /workspace. Critical threshold is 95%.")
        #expect(state?.bodyText.contains("Background processes are disabled until enough space is freed by the guardian.") == true)
        #expect(state?.bodyText.contains("Messages from trusted contacts are blocked until enough space is freed by the guardian.") == true)
    }

    @Test
    func disabledFlagOrUnlockedStatusDoesNotShowAcknowledgementState() {
        #expect(SafeStorageAcknowledgementViewState(
            status: Self.status(acknowledged: false, enabled: false, locked: false, effectivelyLocked: false),
            requiresAcknowledgement: true
        ) == nil)

        #expect(SafeStorageAcknowledgementViewState(
            status: Self.status(acknowledged: false, locked: false, effectivelyLocked: false),
            requiresAcknowledgement: true
        ) == nil)
    }

    @Test
    func acknowledgementErrorMessageIsVisibleWhenProvided() {
        let state = SafeStorageAcknowledgementViewState(
            status: Self.status(acknowledged: false),
            requiresAcknowledgement: true,
            acknowledgementErrorMessage: " Unable to acknowledge storage cleanup. "
        )

        #expect(state?.acknowledgementErrorMessage == "Unable to acknowledge storage cleanup.")
    }

    @Test
    func acknowledgementActionsWireDismissAndCleanupRoutes() {
        var acknowledgeCount = 0
        var cleanupCount = 0
        let actions = MainWindowSafeStorageAcknowledgementActions(
            acknowledge: { acknowledgeCount += 1 },
            focusCleanup: { cleanupCount += 1 }
        )

        actions.acknowledgeOnly()
        #expect(acknowledgeCount == 1)
        #expect(cleanupCount == 0)

        actions.acknowledgeAndFocusCleanup()
        #expect(acknowledgeCount == 2)
        #expect(cleanupCount == 1)
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
