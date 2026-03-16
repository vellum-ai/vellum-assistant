import Foundation
import os
import VellumAssistantShared

private let availabilityLog = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant",
    category: "AppleContainersAvailability"
)

/// Describes why Apple Containers support is unavailable on the current system.
public enum AppleContainersUnavailableReason: Sendable, CustomStringConvertible {
    /// The `apple_containers_enabled` feature flag is off (the default).
    case featureFlagDisabled
    /// The macOS version is older than 15.0, which is required by Apple
    /// Containerization.
    case osTooOld(currentVersion: String)
    /// The optional embedded runtime module was not found inside the app
    /// bundle.  This occurs when the app was built with a toolchain that does
    /// not support Apple Containers (e.g. macOS 14 SDK only).
    case runtimeNotEmbedded
    /// The embedded runtime module was found but failed to load.  The
    /// associated value carries the underlying error description.
    case runtimeLoadFailed(reason: String)

    public var description: String {
        switch self {
        case .featureFlagDisabled:
            return "Apple Containers feature flag is disabled."
        case .osTooOld(let version):
            return "Apple Containers requires macOS 15.0 or later (current: \(version))."
        case .runtimeNotEmbedded:
            return "Apple Containers runtime is not embedded in this build of the app."
        case .runtimeLoadFailed(let reason):
            return "Apple Containers runtime failed to load: \(reason)"
        }
    }
}

/// Availability state for the optional Apple Containers feature.
public enum AppleContainersAvailability: Sendable {
    /// The runtime module is loaded and the feature can be used.
    case available
    /// The feature cannot be used on this system.  The associated value
    /// explains why.
    case unavailable(AppleContainersUnavailableReason)

    /// True when the feature is ready to use.
    public var isAvailable: Bool {
        if case .available = self { return true }
        return false
    }

    /// A human-readable explanation suitable for diagnostic output or
    /// user-facing error messages.
    public var explanation: String {
        switch self {
        case .available:
            return "Apple Containers is available."
        case .unavailable(let reason):
            return reason.description
        }
    }
}

/// Checks and caches the availability of Apple Containers support.
///
/// Call `AppleContainersAvailabilityChecker.shared.check()` to obtain the
/// current availability state.  The result is computed once and cached.
///
/// Resolution order:
/// 1. Feature flag (`apple_containers_enabled`) — if off, returns
///    `.unavailable(.featureFlagDisabled)` immediately.
/// 2. OS version — requires macOS 15.0 or later.
/// 3. Runtime loader — delegates to `AppleContainersRuntimeLoader` to
///    check whether the embedded module is present and loads without error.
///
/// All Apple Containers-specific surfaces (onboarding, settings, launcher,
/// restart) **must** consult this helper rather than performing ad hoc checks.
public final class AppleContainersAvailabilityChecker: @unchecked Sendable {
    public static let shared = AppleContainersAvailabilityChecker()

    private let lock = NSLock()
    private var _cachedResult: AppleContainersAvailability?

    private init() {}

    /// Returns the availability of Apple Containers support, computing it on
    /// the first call and caching it for subsequent calls.
    public func check() -> AppleContainersAvailability {
        lock.lock()
        if let cached = _cachedResult {
            lock.unlock()
            return cached
        }
        lock.unlock()

        let result = computeAvailability()

        lock.lock()
        _cachedResult = result
        lock.unlock()

        availabilityLog.debug("Apple Containers availability: \(result.explanation, privacy: .public)")
        return result
    }

    /// Resets the cached result, forcing a re-check on the next call.
    /// Intended for testing only.
    public func resetCachedResult() {
        lock.lock()
        _cachedResult = nil
        lock.unlock()
    }

    // MARK: - Private helpers

    private func computeAvailability() -> AppleContainersAvailability {
        // 1. Feature flag gate — short-circuit if the flag is off.
        guard MacOSClientFeatureFlagManager.shared.isEnabled("apple_containers_enabled") else {
            availabilityLog.debug("Apple Containers unavailable: feature flag disabled")
            return .unavailable(.featureFlagDisabled)
        }

        // 2. OS version check — Apple Containerization requires macOS 15+.
        let current = ProcessInfo.processInfo.operatingSystemVersion
        guard current.majorVersion >= 15 else {
            let versionString = "\(current.majorVersion).\(current.minorVersion).\(current.patchVersion)"
            availabilityLog.debug("Apple Containers unavailable: OS version \(versionString) < 15.0")
            return .unavailable(.osTooOld(currentVersion: versionString))
        }

        // 3. Delegate to the runtime loader to check whether the embedded module
        // is present and loads without error.
        switch AppleContainersRuntimeLoader.shared.load() {
        case .loaded:
            return .available
        case .notEmbedded:
            return .unavailable(.runtimeNotEmbedded)
        case .failed(let reason):
            return .unavailable(.runtimeLoadFailed(reason: reason))
        }
    }
}
