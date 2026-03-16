import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Tests for `AppleContainersAvailabilityChecker` and its feature-flag gate.
///
/// These tests exercise the availability helper by combining real
/// `MacOSClientFeatureFlagManager` instances with a reset checker so each test
/// starts from a clean state.
final class AppleContainersAvailabilityTests: XCTestCase {

    override func setUp() {
        super.setUp()
        // Reset the cached availability result before each test so tests don't
        // interfere with each other through the shared cached state.
        AppleContainersAvailabilityChecker.shared.resetCachedResult()
        AppleContainersRuntimeLoader.shared.resetLoadResult()
    }

    // MARK: - Feature flag default

    /// The registry default is `defaultEnabled: false`, so without an env
    /// override the checker returns `featureFlagDisabled`.
    func testFeatureFlagOffByDefault() {
        // GIVEN no env override for the Apple Containers flag
        // (MacOSClientFeatureFlagManager.shared uses the real env, which in
        // tests has no VELLUM_FLAG_APPLE_CONTAINERS_ENABLED variable)

        // The checker reads from MacOSClientFeatureFlagManager.shared.
        // We cannot inject the manager directly here, so this test verifies
        // the registry-default path via a separate manager with empty env.
        let manager = MacOSClientFeatureFlagManager(environment: [:])

        // THEN the flag is disabled
        XCTAssertFalse(manager.isEnabled("apple_containers_enabled"))
    }

    // MARK: - Environment variable override

    /// `VELLUM_FLAG_APPLE_CONTAINERS_ENABLED=1` enables the flag via the
    /// standard `MacOSClientFeatureFlagManager` env-var override mechanism.
    func testEnvVarOneEnablesFlag() {
        // GIVEN an env with the flag set to "1"
        let env = ["VELLUM_FLAG_APPLE_CONTAINERS_ENABLED": "1"]
        let manager = MacOSClientFeatureFlagManager(environment: env)

        // THEN the flag is enabled
        XCTAssertTrue(manager.isEnabled("apple_containers_enabled"))
    }

    /// `VELLUM_FLAG_APPLE_CONTAINERS_ENABLED=true` also enables the flag.
    func testEnvVarTrueEnablesFlag() {
        let env = ["VELLUM_FLAG_APPLE_CONTAINERS_ENABLED": "true"]
        let manager = MacOSClientFeatureFlagManager(environment: env)
        XCTAssertTrue(manager.isEnabled("apple_containers_enabled"))
    }

    /// `VELLUM_FLAG_APPLE_CONTAINERS_ENABLED=0` disables the flag.
    func testEnvVarZeroDisablesFlag() {
        let env = ["VELLUM_FLAG_APPLE_CONTAINERS_ENABLED": "0"]
        let manager = MacOSClientFeatureFlagManager(environment: env)
        XCTAssertFalse(manager.isEnabled("apple_containers_enabled"))
    }

    // MARK: - Disabled reason descriptions

    /// `featureFlagDisabled` has a non-empty description.
    func testFeatureFlagDisabledDescription() {
        let reason = AppleContainersUnavailableReason.featureFlagDisabled
        XCTAssertFalse(reason.description.isEmpty)
        XCTAssertTrue(reason.description.contains("flag"))
    }

    /// `osTooOld` includes the version string in its description.
    func testOSTooOldDescriptionIncludesVersion() {
        let reason = AppleContainersUnavailableReason.osTooOld(currentVersion: "14.6.1")
        XCTAssertTrue(reason.description.contains("14.6.1"))
    }

    /// `runtimeNotEmbedded` has a non-empty description.
    func testRuntimeNotEmbeddedDescription() {
        let reason = AppleContainersUnavailableReason.runtimeNotEmbedded
        XCTAssertFalse(reason.description.isEmpty)
    }

    /// `runtimeLoadFailed` includes the reason string in its description.
    func testRuntimeLoadFailedDescriptionIncludesReason() {
        let reason = AppleContainersUnavailableReason.runtimeLoadFailed(reason: "dlopen error 42")
        XCTAssertTrue(reason.description.contains("dlopen error 42"))
    }

    // MARK: - Availability state helpers

    /// `.available` reports `isAvailable == true`.
    func testAvailableIsAvailableTrue() {
        let availability = AppleContainersAvailability.available
        XCTAssertTrue(availability.isAvailable)
    }

    /// `.unavailable` reports `isAvailable == false`.
    func testUnavailableIsAvailableFalse() {
        let availability = AppleContainersAvailability.unavailable(.featureFlagDisabled)
        XCTAssertFalse(availability.isAvailable)
    }

    /// `.available` has a non-empty explanation.
    func testAvailableExplanation() {
        let availability = AppleContainersAvailability.available
        XCTAssertFalse(availability.explanation.isEmpty)
    }

    /// `.unavailable` explanation matches the reason's description.
    func testUnavailableExplanationMatchesReason() {
        let reason = AppleContainersUnavailableReason.featureFlagDisabled
        let availability = AppleContainersAvailability.unavailable(reason)
        XCTAssertEqual(availability.explanation, reason.description)
    }

    // MARK: - Checker caching

    /// Calling `check()` twice returns the same result (cached path).
    func testCheckerResultIsCached() {
        // Calling check() twice must return identical results — the second call
        // goes through the cached path.
        let first = AppleContainersAvailabilityChecker.shared.check()
        let second = AppleContainersAvailabilityChecker.shared.check()

        // Both calls should agree on availability.
        XCTAssertEqual(first.isAvailable, second.isAvailable)
    }

    /// After `resetCachedResult()`, `check()` re-evaluates availability.
    func testResetCachedResultClearsCache() {
        _ = AppleContainersAvailabilityChecker.shared.check()
        AppleContainersAvailabilityChecker.shared.resetCachedResult()
        // A second check after reset should succeed without crashing.
        _ = AppleContainersAvailabilityChecker.shared.check()
    }
}
