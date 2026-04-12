import XCTest
@testable import VellumAssistantLib

@MainActor
@available(macOS 26.0, *)
final class AppleContainersLauncherTests: XCTestCase {

    private var originalCheckAvailability: (() -> AppleContainersAvailabilityChecker.Availability)!

    override func setUp() {
        super.setUp()
        originalCheckAvailability = AppleContainersLauncher.checkAvailability
    }

    override func tearDown() {
        AppleContainersLauncher.checkAvailability = originalCheckAvailability
        super.tearDown()
    }

    // MARK: - Availability gate

    func testHatchThrowsWhenFeatureFlagDisabled() async {
        AppleContainersLauncher.checkAvailability = { .unavailable(.featureFlagDisabled) }
        let launcher = AppleContainersLauncher()
        do {
            try await launcher.hatch(name: "test", configValues: [:])
            XCTFail("Expected throw")
        } catch let error as AppleContainersLauncher.LauncherError {
            if case .unavailable(.featureFlagDisabled) = error {} else {
                XCTFail("Expected .featureFlagDisabled, got \(error)")
            }
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
    }

    func testHatchThrowsWhenOSUnsupported() async {
        AppleContainersLauncher.checkAvailability = { .unavailable(.unsupportedOS) }
        let launcher = AppleContainersLauncher()
        do {
            try await launcher.hatch(name: "test", configValues: [:])
            XCTFail("Expected throw")
        } catch let error as AppleContainersLauncher.LauncherError {
            if case .unavailable(.unsupportedOS) = error {} else {
                XCTFail("Expected .unsupportedOS, got \(error)")
            }
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
    }

    func testHatchThrowsWhenHardwareUnsupported() async {
        AppleContainersLauncher.checkAvailability = { .unavailable(.unsupportedHardware) }
        let launcher = AppleContainersLauncher()
        do {
            try await launcher.hatch(name: "test", configValues: [:])
            XCTFail("Expected throw")
        } catch let error as AppleContainersLauncher.LauncherError {
            if case .unavailable(.unsupportedHardware) = error {} else {
                XCTFail("Expected .unsupportedHardware, got \(error)")
            }
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
    }

    // MARK: - Error descriptions

    func testErrorDescriptions() {
        XCTAssertTrue(
            AppleContainersLauncher.LauncherError.unavailable(.featureFlagDisabled)
                .errorDescription!.contains("feature flag")
        )
        XCTAssertTrue(
            AppleContainersLauncher.LauncherError.unavailable(.unsupportedOS)
                .errorDescription!.contains("macOS 26")
        )
        XCTAssertTrue(
            AppleContainersLauncher.LauncherError.unavailable(.unsupportedHardware)
                .errorDescription!.contains("ARM64")
        )
        XCTAssertTrue(
            AppleContainersLauncher.LauncherError.hatchFailed("boom")
                .errorDescription!.contains("boom")
        )
    }

    // MARK: - Lockfile

    func testWriteLockfileEntryCreatesNewEntry() throws {
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("launcher-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        let lockfilePath = tmpDir.appendingPathComponent(".vellum.lock.json").path

        let result = AppleContainersLauncher.writeLockfileEntry(
            assistantId: "test-ac",
            hatchedAt: "2026-01-01T00:00:00Z",
            signingKey: "abc123",
            lockfilePath: lockfilePath
        )
        XCTAssertTrue(result)

        let data = try Data(contentsOf: URL(fileURLWithPath: lockfilePath))
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        let assistants = json["assistants"] as! [[String: Any]]
        XCTAssertEqual(assistants.count, 1)
        XCTAssertEqual(assistants[0]["assistantId"] as? String, "test-ac")
        XCTAssertEqual(assistants[0]["cloud"] as? String, "apple-container")
        XCTAssertEqual(assistants[0]["runtimeBackend"] as? String, "apple-containers")
        let resources = assistants[0]["resources"] as? [String: Any]
        XCTAssertEqual(resources?["signingKey"] as? String, "abc123")
    }

    func testWriteLockfileEntryUpdatesExisting() throws {
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("launcher-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        let lockfilePath = tmpDir.appendingPathComponent(".vellum.lock.json").path

        // Write initial entry
        AppleContainersLauncher.writeLockfileEntry(
            assistantId: "test-ac",
            hatchedAt: "2026-01-01T00:00:00Z",
            signingKey: "old-key",
            lockfilePath: lockfilePath
        )

        // Overwrite
        AppleContainersLauncher.writeLockfileEntry(
            assistantId: "test-ac",
            hatchedAt: "2026-02-01T00:00:00Z",
            signingKey: "new-key",
            lockfilePath: lockfilePath
        )

        let data = try Data(contentsOf: URL(fileURLWithPath: lockfilePath))
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        let assistants = json["assistants"] as! [[String: Any]]
        XCTAssertEqual(assistants.count, 1)
        XCTAssertEqual(assistants[0]["hatchedAt"] as? String, "2026-02-01T00:00:00Z")
        let resources = assistants[0]["resources"] as? [String: Any]
        XCTAssertEqual(resources?["signingKey"] as? String, "new-key")
    }

    // MARK: - Protocol conformance

    func testConformsToAssistantManagementClient() {
        let launcher = AppleContainersLauncher()
        XCTAssertTrue(launcher is AssistantManaging)
    }
}
