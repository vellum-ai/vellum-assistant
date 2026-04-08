import Foundation
import VellumAssistantShared

/// Centralized gate that determines whether Apple Containers can be offered
/// as a hatch backend on the current machine. Combines the LaunchDarkly
/// feature flag, OS version requirement, and hardware compatibility checks
/// into a single query so callers don't duplicate the logic.
enum AppleContainersAvailabilityChecker {

    /// Describes why Apple Containers are unavailable.
    enum UnavailableReason: Equatable, Sendable {
        /// The `apple-container` feature flag is disabled.
        case featureFlagDisabled
        /// The host is running a macOS version older than 26.
        case unsupportedOS
        /// The host is not running on Apple Silicon (ARM64).
        case unsupportedHardware
    }

    /// The result of an availability check.
    enum Availability: Equatable, Sendable {
        case available
        case unavailable(UnavailableReason)

        var isAvailable: Bool {
            self == .available
        }
    }

    // MARK: - Overridable Hooks (for testing)

    /// Closure that checks whether the feature flag is enabled.
    /// Default implementation reads from `MacOSClientFeatureFlagManager`.
    nonisolated(unsafe) static var isFeatureFlagEnabled: () -> Bool = {
        MacOSClientFeatureFlagManager.shared.isEnabled("apple-container")
    }

    /// Closure that checks whether the OS meets the minimum version.
    /// Default implementation requires macOS 26.0+.
    nonisolated(unsafe) static var meetsOSRequirement: () -> Bool = {
        if #available(macOS 26.0, *) {
            return true
        }
        return false
    }

    /// Closure that checks whether the hardware architecture is ARM64.
    /// Default implementation inspects the machine's `hw.machine` sysctl.
    nonisolated(unsafe) static var isARM64: () -> Bool = {
        #if arch(arm64)
        return true
        #else
        return false
        #endif
    }

    // MARK: - Public API

    /// Evaluate all prerequisites and return the availability status.
    ///
    /// Checks are ordered from cheapest/most-likely-to-fail first:
    /// 1. Feature flag — most users won't have this enabled yet.
    /// 2. OS version — requires macOS 26 (Tahoe).
    /// 3. Hardware — requires Apple Silicon (ARM64).
    static func check() -> Availability {
        guard isFeatureFlagEnabled() else {
            return .unavailable(.featureFlagDisabled)
        }
        guard meetsOSRequirement() else {
            return .unavailable(.unsupportedOS)
        }
        guard isARM64() else {
            return .unavailable(.unsupportedHardware)
        }
        return .available
    }
}
