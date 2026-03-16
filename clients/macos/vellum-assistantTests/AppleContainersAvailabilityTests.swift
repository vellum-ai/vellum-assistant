import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

final class AppleContainersAvailabilityTests: XCTestCase {

    // MARK: - Feature flag gate

    /// The registry default is false, so with no env override the flag is off.
    func testFeatureFlagOffByDefault() {
        // GIVEN a flag manager with no overrides (empty environment)
        let manager = MacOSClientFeatureFlagManager(environment: [:])

        // WHEN we evaluate availability
        let availability = AppleContainersAvailabilityChecker.evaluate(
            flagManager: manager,
            osVersion: .init(majorVersion: 15, minorVersion: 0, patchVersion: 0),
            bundleChecker: { true },
            runtimeLoaderReady: { true }
        )

        // THEN the feature is unavailable with featureFlagDisabled as the only reason
        XCTAssertFalse(availability.isAvailable)
        XCTAssertEqual(availability.unavailableReasons, [.featureFlagDisabled])
    }

    /// Setting VELLUM_FLAG_APPLE_CONTAINERS_ENABLED=1 enables the flag.
    func testEnvVarOverrideEnablesFlag() {
        // GIVEN a flag manager with the Apple Containers env var set to "1"
        let env = ["VELLUM_FLAG_APPLE_CONTAINERS_ENABLED": "1"]
        let manager = MacOSClientFeatureFlagManager(environment: env)

        // WHEN we evaluate on a capable system
        let availability = AppleContainersAvailabilityChecker.evaluate(
            flagManager: manager,
            osVersion: .init(majorVersion: 15, minorVersion: 0, patchVersion: 0),
            bundleChecker: { true },
            runtimeLoaderReady: { true }
        )

        // THEN the feature is available
        XCTAssertTrue(availability.isAvailable)
        XCTAssertEqual(availability.unavailableReasons, [])
    }

    /// VELLUM_FLAG_APPLE_CONTAINERS_ENABLED=true also enables the flag.
    func testEnvVarTrueEnablesFlag() {
        // GIVEN a flag manager with the Apple Containers env var set to "true"
        let env = ["VELLUM_FLAG_APPLE_CONTAINERS_ENABLED": "true"]
        let manager = MacOSClientFeatureFlagManager(environment: env)

        // WHEN we evaluate on a capable system
        let availability = AppleContainersAvailabilityChecker.evaluate(
            flagManager: manager,
            osVersion: .init(majorVersion: 15, minorVersion: 0, patchVersion: 0),
            bundleChecker: { true },
            runtimeLoaderReady: { true }
        )

        // THEN the feature is available
        XCTAssertTrue(availability.isAvailable)
    }

    // MARK: - Feature flag short-circuit

    /// When the flag is off, capability checks are skipped entirely.
    func testFeatureFlagOffShortCircuitsCapabilityChecks() {
        // GIVEN a flag manager with the flag disabled
        let manager = MacOSClientFeatureFlagManager(environment: [:])
        var bundleCheckerCalled = false
        var runtimeLoaderCalled = false

        // WHEN we evaluate availability
        let availability = AppleContainersAvailabilityChecker.evaluate(
            flagManager: manager,
            osVersion: .init(majorVersion: 15, minorVersion: 0, patchVersion: 0),
            bundleChecker: { bundleCheckerCalled = true; return false },
            runtimeLoaderReady: { runtimeLoaderCalled = true; return false }
        )

        // THEN only featureFlagDisabled is reported and no capability checks ran
        XCTAssertEqual(availability.unavailableReasons, [.featureFlagDisabled])
        XCTAssertFalse(bundleCheckerCalled, "bundleChecker should not be called when feature flag is off")
        XCTAssertFalse(runtimeLoaderCalled, "runtimeLoaderReady should not be called when feature flag is off")
    }

    // MARK: - OS version check

    /// macOS 14 is too low — requires macOS 15+.
    func testOSTooOldReturnsOSVersionTooLow() {
        // GIVEN the flag is on but the OS is macOS 14
        let env = ["VELLUM_FLAG_APPLE_CONTAINERS_ENABLED": "1"]
        let manager = MacOSClientFeatureFlagManager(environment: env)

        // WHEN we evaluate with macOS 14
        let availability = AppleContainersAvailabilityChecker.evaluate(
            flagManager: manager,
            osVersion: .init(majorVersion: 14, minorVersion: 7, patchVersion: 0),
            bundleChecker: { true },
            runtimeLoaderReady: { true }
        )

        // THEN the feature is unavailable with osVersionTooLow
        XCTAssertFalse(availability.isAvailable)
        XCTAssertTrue(availability.unavailableReasons.contains(.osVersionTooLow))
    }

    /// macOS 15.0 is the minimum supported version.
    func testMacOS15IsSupported() {
        // GIVEN the flag is on and the OS is exactly macOS 15.0
        let env = ["VELLUM_FLAG_APPLE_CONTAINERS_ENABLED": "1"]
        let manager = MacOSClientFeatureFlagManager(environment: env)

        // WHEN we evaluate with macOS 15.0
        let availability = AppleContainersAvailabilityChecker.evaluate(
            flagManager: manager,
            osVersion: .init(majorVersion: 15, minorVersion: 0, patchVersion: 0),
            bundleChecker: { true },
            runtimeLoaderReady: { true }
        )

        // THEN osVersionTooLow is not in the reasons
        XCTAssertFalse(availability.unavailableReasons.contains(.osVersionTooLow))
    }

    // MARK: - Runtime bundle check

    /// Missing runtime bundle is reported as runtimeBundleNotFound.
    func testMissingRuntimeBundleReturnsRuntimeBundleNotFound() {
        // GIVEN the flag is on, OS is fine, but the runtime bundle is absent
        let env = ["VELLUM_FLAG_APPLE_CONTAINERS_ENABLED": "1"]
        let manager = MacOSClientFeatureFlagManager(environment: env)

        // WHEN we evaluate with a missing bundle
        let availability = AppleContainersAvailabilityChecker.evaluate(
            flagManager: manager,
            osVersion: .init(majorVersion: 15, minorVersion: 0, patchVersion: 0),
            bundleChecker: { false },
            runtimeLoaderReady: { true }
        )

        // THEN the feature is unavailable with runtimeBundleNotFound
        XCTAssertFalse(availability.isAvailable)
        XCTAssertTrue(availability.unavailableReasons.contains(.runtimeBundleNotFound))
    }

    // MARK: - Runtime loader check

    /// A runtime loader that is not ready is reported as runtimeLoaderNotReady.
    func testRuntimeLoaderNotReadyReturnsRuntimeLoaderNotReady() {
        // GIVEN the flag is on, OS is fine, bundle is present, but loader is not ready
        let env = ["VELLUM_FLAG_APPLE_CONTAINERS_ENABLED": "1"]
        let manager = MacOSClientFeatureFlagManager(environment: env)

        // WHEN we evaluate with a not-ready runtime loader
        let availability = AppleContainersAvailabilityChecker.evaluate(
            flagManager: manager,
            osVersion: .init(majorVersion: 15, minorVersion: 0, patchVersion: 0),
            bundleChecker: { true },
            runtimeLoaderReady: { false }
        )

        // THEN the feature is unavailable with runtimeLoaderNotReady
        XCTAssertFalse(availability.isAvailable)
        XCTAssertTrue(availability.unavailableReasons.contains(.runtimeLoaderNotReady))
    }

    // MARK: - Multiple reasons

    /// All capability failure reasons are accumulated and returned together.
    func testMultipleDisabledReasonsAreAccumulated() {
        // GIVEN the flag is on but all capability checks fail
        let env = ["VELLUM_FLAG_APPLE_CONTAINERS_ENABLED": "1"]
        let manager = MacOSClientFeatureFlagManager(environment: env)

        // WHEN we evaluate with every capability failing
        let availability = AppleContainersAvailabilityChecker.evaluate(
            flagManager: manager,
            osVersion: .init(majorVersion: 14, minorVersion: 0, patchVersion: 0),
            bundleChecker: { false },
            runtimeLoaderReady: { false }
        )

        // THEN all three capability reasons are present
        let reasons = availability.unavailableReasons
        XCTAssertFalse(availability.isAvailable)
        XCTAssertTrue(reasons.contains(.osVersionTooLow))
        XCTAssertTrue(reasons.contains(.runtimeBundleNotFound))
        XCTAssertTrue(reasons.contains(.runtimeLoaderNotReady))
        XCTAssertEqual(reasons.count, 3)
    }

    // MARK: - Availability helpers

    /// `.available` reports `isAvailable == true` and empty reasons.
    func testAvailableStateHelpers() {
        let availability = AppleContainersAvailability.available
        XCTAssertTrue(availability.isAvailable)
        XCTAssertEqual(availability.unavailableReasons, [])
    }

    /// `.unavailable` reports `isAvailable == false` and the correct reasons.
    func testUnavailableStateHelpers() {
        let reasons: [AppleContainersUnavailableReason] = [.featureFlagDisabled]
        let availability = AppleContainersAvailability.unavailable(reasons)
        XCTAssertFalse(availability.isAvailable)
        XCTAssertEqual(availability.unavailableReasons, reasons)
    }

    // MARK: - UnavailableReason descriptions

    /// Each reason has a non-empty human-readable description.
    func testUnavailableReasonDescriptions() {
        let reasons: [AppleContainersUnavailableReason] = [
            .featureFlagDisabled,
            .osVersionTooLow,
            .runtimeBundleNotFound,
            .runtimeLoaderNotReady
        ]
        for reason in reasons {
            XCTAssertFalse(reason.description.isEmpty, "\(reason) should have a non-empty description")
        }
    }
}
