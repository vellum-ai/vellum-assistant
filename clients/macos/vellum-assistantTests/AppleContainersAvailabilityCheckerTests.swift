import XCTest
@testable import VellumAssistantLib

final class AppleContainersAvailabilityCheckerTests: XCTestCase {

    // Save originals so each test can restore them in tearDown.
    private var originalFeatureFlag: (() -> Bool)!
    private var originalOSRequirement: (() -> Bool)!
    private var originalIsARM64: (() -> Bool)!

    override func setUp() {
        super.setUp()
        originalFeatureFlag = AppleContainersAvailabilityChecker.isFeatureFlagEnabled
        originalOSRequirement = AppleContainersAvailabilityChecker.meetsOSRequirement
        originalIsARM64 = AppleContainersAvailabilityChecker.isARM64
    }

    override func tearDown() {
        AppleContainersAvailabilityChecker.isFeatureFlagEnabled = originalFeatureFlag
        AppleContainersAvailabilityChecker.meetsOSRequirement = originalOSRequirement
        AppleContainersAvailabilityChecker.isARM64 = originalIsARM64
        super.tearDown()
    }

    // MARK: - All checks pass

    func testAvailableWhenAllCheckPass() {
        AppleContainersAvailabilityChecker.isFeatureFlagEnabled = { true }
        AppleContainersAvailabilityChecker.meetsOSRequirement = { true }
        AppleContainersAvailabilityChecker.isARM64 = { true }

        let result = AppleContainersAvailabilityChecker.check()
        XCTAssertEqual(result, .available)
        XCTAssertTrue(result.isAvailable)
    }

    // MARK: - Feature flag disabled

    func testUnavailableWhenFeatureFlagDisabled() {
        AppleContainersAvailabilityChecker.isFeatureFlagEnabled = { false }
        AppleContainersAvailabilityChecker.meetsOSRequirement = { true }
        AppleContainersAvailabilityChecker.isARM64 = { true }

        let result = AppleContainersAvailabilityChecker.check()
        XCTAssertEqual(result, .unavailable(.featureFlagDisabled))
        XCTAssertFalse(result.isAvailable)
    }

    // MARK: - OS version too low

    func testUnavailableWhenOSTooOld() {
        AppleContainersAvailabilityChecker.isFeatureFlagEnabled = { true }
        AppleContainersAvailabilityChecker.meetsOSRequirement = { false }
        AppleContainersAvailabilityChecker.isARM64 = { true }

        let result = AppleContainersAvailabilityChecker.check()
        XCTAssertEqual(result, .unavailable(.unsupportedOS))
    }

    // MARK: - Wrong architecture

    func testUnavailableWhenNotARM64() {
        AppleContainersAvailabilityChecker.isFeatureFlagEnabled = { true }
        AppleContainersAvailabilityChecker.meetsOSRequirement = { true }
        AppleContainersAvailabilityChecker.isARM64 = { false }

        let result = AppleContainersAvailabilityChecker.check()
        XCTAssertEqual(result, .unavailable(.unsupportedHardware))
    }

    // MARK: - Priority ordering

    func testFeatureFlagCheckedBeforeOS() {
        AppleContainersAvailabilityChecker.isFeatureFlagEnabled = { false }
        AppleContainersAvailabilityChecker.meetsOSRequirement = { false }
        AppleContainersAvailabilityChecker.isARM64 = { true }

        let result = AppleContainersAvailabilityChecker.check()
        XCTAssertEqual(result, .unavailable(.featureFlagDisabled))
    }

    func testOSCheckedBeforeHardware() {
        AppleContainersAvailabilityChecker.isFeatureFlagEnabled = { true }
        AppleContainersAvailabilityChecker.meetsOSRequirement = { false }
        AppleContainersAvailabilityChecker.isARM64 = { false }

        let result = AppleContainersAvailabilityChecker.check()
        XCTAssertEqual(result, .unavailable(.unsupportedOS))
    }

    func testAllChecksFailReturnsFeatureFlagReason() {
        AppleContainersAvailabilityChecker.isFeatureFlagEnabled = { false }
        AppleContainersAvailabilityChecker.meetsOSRequirement = { false }
        AppleContainersAvailabilityChecker.isARM64 = { false }

        let result = AppleContainersAvailabilityChecker.check()
        XCTAssertEqual(result, .unavailable(.featureFlagDisabled))
    }
}
