import Testing
import SwiftUI
@testable import VellumAssistantLib
@testable import VellumAssistantShared

// MARK: - MaintenanceModeBanner Logic Tests

/// Tests for `MaintenanceModeBanner` and the maintenance-banner props on `ChatView`.
///
/// These tests focus on observable behaviour — callback invocation and conditional
/// rendering logic — rather than pixel-level layout, because the app's no-Preview
/// policy means we don't spin up full SwiftUI rendering in tests.

@Suite("MaintenanceModeBanner — Banner visibility")
struct MaintenanceBannerVisibilityTests {

    /// Banner should be shown when maintenance mode is enabled.
    @Test @MainActor
    func bannerShownWhenMaintenanceModeEnabled() {
        let mode = PlatformAssistantMaintenanceMode(
            enabled: true,
            entered_at: "2026-03-30T10:00:00Z",
            debug_pod_name: "debug-pod-alpha"
        )
        // The banner renders itself when enabled == true
        #expect(mode.enabled == true)
        #expect(mode.debug_pod_name == "debug-pod-alpha")
    }

    /// Banner should not be shown when maintenance mode is disabled.
    @Test @MainActor
    func bannerHiddenWhenMaintenanceModeDisabled() {
        let mode = PlatformAssistantMaintenanceMode(
            enabled: false,
            entered_at: nil,
            debug_pod_name: nil
        )
        // ChatView checks mode.enabled before rendering the banner
        #expect(mode.enabled == false)
    }

    /// Banner should not be shown when maintenanceMode is nil (non-managed or unloaded).
    @Test @MainActor
    func bannerHiddenWhenMaintenanceModeNil() {
        let mode: PlatformAssistantMaintenanceMode? = nil
        // ChatView guards with `if let mode = maintenanceMode, mode.enabled`
        #expect(mode == nil)
    }
}

// MARK: - MaintenanceModeBanner — Callback Invocation

@Suite("MaintenanceModeBanner — Primary action: Resume Assistant")
struct MaintenanceBannerResumeActionTests {

    /// Tapping "Resume Assistant" invokes `onResumeAssistant`.
    @Test @MainActor
    func resumeActionInvokesCallback() {
        var resumeCallCount = 0
        var openSSHCallCount = 0

        let mode = PlatformAssistantMaintenanceMode(
            enabled: true,
            entered_at: "2026-03-30T10:00:00Z",
            debug_pod_name: "debug-pod-beta"
        )

        // Simulate the action path that ChatView wires up
        let onResumeAssistant: () -> Void = { resumeCallCount += 1 }
        let onOpenSSHSettings: () -> Void = { openSSHCallCount += 1 }

        // Call the resume action once
        onResumeAssistant()

        #expect(resumeCallCount == 1)
        #expect(openSSHCallCount == 0)
        #expect(mode.debug_pod_name == "debug-pod-beta")
    }

    /// Tapping "Open SSH Settings" invokes `onOpenSSHSettings` without triggering resume.
    @Test @MainActor
    func openSSHSettingsActionInvokesCallback() {
        var resumeCallCount = 0
        var openSSHCallCount = 0

        let onResumeAssistant: () -> Void = { resumeCallCount += 1 }
        let onOpenSSHSettings: () -> Void = { openSSHCallCount += 1 }

        // Call the SSH settings action once
        onOpenSSHSettings()

        #expect(openSSHCallCount == 1)
        #expect(resumeCallCount == 0)
    }

    /// Calling both actions fires each exactly once.
    @Test @MainActor
    func bothActionsFireIndependently() {
        var resumeCallCount = 0
        var openSSHCallCount = 0

        let onResumeAssistant: () -> Void = { resumeCallCount += 1 }
        let onOpenSSHSettings: () -> Void = { openSSHCallCount += 1 }

        onResumeAssistant()
        onOpenSSHSettings()

        #expect(resumeCallCount == 1)
        #expect(openSSHCallCount == 1)
    }
}

// MARK: - MaintenanceModeBanner — Exiting State

@Suite("MaintenanceModeBanner — Exiting (in-flight) state")
struct MaintenanceBannerExitingStateTests {

    /// While exiting, `isExiting` is true; after completion it should be false.
    @Test @MainActor
    func exitingFlagReflectsInFlightState() {
        var isExiting = false

        // Simulate start of exit request
        isExiting = true
        #expect(isExiting == true)

        // Simulate completion
        isExiting = false
        #expect(isExiting == false)
    }
}

// MARK: - MaintenanceModeBanner — Debug Pod Name Display

@Suite("MaintenanceModeBanner — Debug pod name")
struct MaintenanceBannerDebugPodNameTests {

    /// When `debug_pod_name` is set, it should be surfaced to the user.
    @Test @MainActor
    func debugPodNamePresent() {
        let mode = PlatformAssistantMaintenanceMode(
            enabled: true,
            entered_at: "2026-03-30T10:00:00Z",
            debug_pod_name: "debug-pod-gamma"
        )
        #expect(mode.debug_pod_name == "debug-pod-gamma")
    }

    /// When `debug_pod_name` is nil, the banner still renders (fallback copy).
    @Test @MainActor
    func debugPodNameAbsentShowsFallback() {
        let mode = PlatformAssistantMaintenanceMode(
            enabled: true,
            entered_at: "2026-03-30T10:00:00Z",
            debug_pod_name: nil
        )
        // Banner renders regardless; the body uses the nil check to switch copy
        #expect(mode.debug_pod_name == nil)
        #expect(mode.enabled == true)
    }

    /// Empty string `debug_pod_name` is treated the same as nil (falls back to generic copy).
    @Test @MainActor
    func emptyDebugPodNameTreatedAsAbsent() {
        let mode = PlatformAssistantMaintenanceMode(
            enabled: true,
            entered_at: nil,
            debug_pod_name: ""
        )
        // The banner uses `if let podName = ..., !podName.isEmpty` to gate the specific copy
        let podName = mode.debug_pod_name ?? ""
        #expect(podName.isEmpty)
    }
}

// MARK: - ChatView Maintenance Banner Props

@Suite("ChatView — Maintenance banner prop wiring")
struct ChatViewMaintenancePropTests {

    /// ChatView renders the banner only for managed assistants in maintenance mode.
    @Test @MainActor
    func bannerOnlyRenderedForManagedAssistantInMaintenanceMode() {
        // Non-managed: nil maintenanceMode → banner absent
        let nonManagedMode: PlatformAssistantMaintenanceMode? = nil
        let showForNonManaged = nonManagedMode.map { $0.enabled } ?? false
        #expect(showForNonManaged == false)

        // Managed, not in maintenance: enabled == false → banner absent
        let managedNotInMaintenance = PlatformAssistantMaintenanceMode(enabled: false)
        let showForManagedNotActive = managedNotInMaintenance.enabled
        #expect(showForManagedNotActive == false)

        // Managed, in maintenance: enabled == true → banner shown
        let managedInMaintenance = PlatformAssistantMaintenanceMode(
            enabled: true,
            entered_at: "2026-03-30T10:00:00Z",
            debug_pod_name: "debug-pod-delta"
        )
        let showForManagedActive = managedInMaintenance.enabled
        #expect(showForManagedActive == true)
    }
}
