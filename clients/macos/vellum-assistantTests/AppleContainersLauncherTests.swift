import XCTest
@testable import VellumAssistantLib

@MainActor
final class AppleContainersLauncherTests: XCTestCase {

    private var originalCheckAvailability: (() -> AppleContainersAvailabilityChecker.Availability)!
    private var originalLocateBundledKernel: (() -> URL?)!

    override func setUp() {
        super.setUp()
        originalCheckAvailability = AppleContainersLauncher.checkAvailability
        originalLocateBundledKernel = AppleContainersLauncher.locateBundledKernel
    }

    override func tearDown() {
        AppleContainersLauncher.checkAvailability = originalCheckAvailability
        AppleContainersLauncher.locateBundledKernel = originalLocateBundledKernel
        super.tearDown()
    }

    // MARK: - Availability gate

    func testHatchThrowsWhenFeatureFlagDisabled() async {
        AppleContainersLauncher.checkAvailability = { .unavailable(.featureFlagDisabled) }

        let launcher = AppleContainersLauncher()
        do {
            try await launcher.hatch(name: "test", configValues: [:])
            XCTFail("Expected hatch to throw when feature flag is disabled")
        } catch let error as AppleContainersLauncher.LauncherError {
            if case .unavailable(.featureFlagDisabled) = error {
                // expected
            } else {
                XCTFail("Expected .unavailable(.featureFlagDisabled), got \(error)")
            }
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    func testHatchThrowsWhenOSUnsupported() async {
        AppleContainersLauncher.checkAvailability = { .unavailable(.unsupportedOS) }

        let launcher = AppleContainersLauncher()
        do {
            try await launcher.hatch(name: "test", configValues: [:])
            XCTFail("Expected hatch to throw when OS is unsupported")
        } catch let error as AppleContainersLauncher.LauncherError {
            if case .unavailable(.unsupportedOS) = error {
                // expected
            } else {
                XCTFail("Expected .unavailable(.unsupportedOS), got \(error)")
            }
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    func testHatchThrowsWhenHardwareUnsupported() async {
        AppleContainersLauncher.checkAvailability = { .unavailable(.unsupportedHardware) }

        let launcher = AppleContainersLauncher()
        do {
            try await launcher.hatch(name: "test", configValues: [:])
            XCTFail("Expected hatch to throw when hardware is unsupported")
        } catch let error as AppleContainersLauncher.LauncherError {
            if case .unavailable(.unsupportedHardware) = error {
                // expected
            } else {
                XCTFail("Expected .unavailable(.unsupportedHardware), got \(error)")
            }
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    // MARK: - Kernel not found

    func testHatchThrowsWhenKernelNotFound() async {
        AppleContainersLauncher.checkAvailability = { .available }
        AppleContainersLauncher.locateBundledKernel = { nil }

        let launcher = AppleContainersLauncher()
        do {
            try await launcher.hatch(name: "test", configValues: [:])
            XCTFail("Expected hatch to throw when kernel is not found")
        } catch let error as AppleContainersLauncher.LauncherError {
            if case .kernelNotFound = error {
                // expected
            } else {
                XCTFail("Expected .kernelNotFound, got \(error)")
            }
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    // MARK: - Error descriptions

    func testErrorDescriptions() {
        let featureFlagError = AppleContainersLauncher.LauncherError.unavailable(.featureFlagDisabled)
        XCTAssertTrue(featureFlagError.errorDescription?.contains("feature flag") == true)

        let osError = AppleContainersLauncher.LauncherError.unavailable(.unsupportedOS)
        XCTAssertTrue(osError.errorDescription?.contains("macOS 26") == true)

        let hardwareError = AppleContainersLauncher.LauncherError.unavailable(.unsupportedHardware)
        XCTAssertTrue(hardwareError.errorDescription?.contains("ARM64") == true)

        let kernelError = AppleContainersLauncher.LauncherError.kernelNotFound
        XCTAssertTrue(kernelError.errorDescription?.contains("kernel") == true)

        let hatchError = AppleContainersLauncher.LauncherError.hatchFailed("container crashed")
        XCTAssertTrue(hatchError.errorDescription?.contains("container crashed") == true)
    }

    // MARK: - Protocol conformance

    func testConformsToAssistantManagementClient() {
        let launcher = AppleContainersLauncher()
        XCTAssertTrue(launcher is AssistantManagementClient)
    }
}
