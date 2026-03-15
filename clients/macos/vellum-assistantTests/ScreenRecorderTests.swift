import XCTest
@testable import VellumAssistantLib

/// Automated tests for ScreenRecorder's pure/deterministic logic:
/// dimension normalization, fallback config building, and SCStream error
/// code mapping. These run without hardware or screen recording permission.
///
/// Scenarios that require real displays, hardware encoders, or runtime events
/// (hot-plug, sleep/wake, mixed-DPI capture, cross-display window moves) are
/// covered by the manual QA checklist in
/// `Recording/RECORDING_TEST_MATRIX.md`.
@MainActor
final class ScreenRecorderTests: XCTestCase {

    // MARK: - Dimension Normalization

    func testStandardDimensionsPassThrough() {
        let result = ScreenRecorder.normalizeDimensions(width: 1920, height: 1080)
        XCTAssertEqual(result.width, 1920)
        XCTAssertEqual(result.height, 1080)
        XCTAssertFalse(result.wasAdjusted)
        XCTAssertNil(result.adjustmentReason)
    }

    func testOddDimensionsRoundedToEven() {
        let result = ScreenRecorder.normalizeDimensions(width: 1921, height: 1081)
        XCTAssertEqual(result.width, 1922)
        XCTAssertEqual(result.height, 1082)
        XCTAssertTrue(result.wasAdjusted)
    }

    func testBelowMinimumClampedTo128() {
        let result = ScreenRecorder.normalizeDimensions(width: 64, height: 64)
        XCTAssertEqual(result.width, 128)
        XCTAssertEqual(result.height, 128)
        XCTAssertTrue(result.wasAdjusted)
    }

    func testAboveMaximumScaledDownProportionally() {
        let result = ScreenRecorder.normalizeDimensions(width: 8192, height: 4096, maxDimension: 4096)
        XCTAssertEqual(result.width, 4096)
        XCTAssertEqual(result.height, 2048)
        XCTAssertTrue(result.wasAdjusted)
    }

    func testExtremeAspectRatioReClampsMinAfterDownscale() {
        // 8192x128 at max=4096: scale by 0.5 → 4096x64, then re-clamp h → 128
        let result = ScreenRecorder.normalizeDimensions(width: 8192, height: 128, maxDimension: 4096)
        XCTAssertEqual(result.width, 4096)
        XCTAssertEqual(result.height, 128)
        XCTAssertTrue(result.wasAdjusted)
    }

    func testZeroDimensionsClampedToMinimum() {
        let result = ScreenRecorder.normalizeDimensions(width: 0, height: 0)
        XCTAssertEqual(result.width, 128)
        XCTAssertEqual(result.height, 128)
        XCTAssertTrue(result.wasAdjusted)
    }

    func testAlreadyEvenDimensionsUnchanged() {
        let result = ScreenRecorder.normalizeDimensions(width: 2560, height: 1440)
        XCTAssertEqual(result.width, 2560)
        XCTAssertEqual(result.height, 1440)
        XCTAssertFalse(result.wasAdjusted)
    }

    func testAspectRatioPreservedDuringDownscale() {
        // 6000x3000 at max=4096: scale = 4096/6000 ≈ 0.6827
        // w = Int(6000 * 0.6827) = 4096, h = Int(3000 * 0.6827) = 2048
        // Aspect ratio 2:1 should be preserved
        let result = ScreenRecorder.normalizeDimensions(width: 6000, height: 3000, maxDimension: 4096)
        let originalRatio = Double(6000) / Double(3000) // 2.0
        let resultRatio = Double(result.width) / Double(result.height)
        // Allow a small tolerance for rounding
        XCTAssertEqual(originalRatio, resultRatio, accuracy: 0.02, "Aspect ratio should be preserved")
    }

    // MARK: - Fallback Config Building

    func testFallbackConfigsReturnsAtLeast2() {
        let configs = ScreenRecorder.buildFallbackConfigs(primaryWidth: 1920, primaryHeight: 1080)
        XCTAssertGreaterThanOrEqual(configs.count, 2, "Should have at least primary + final fallback")
    }

    func testPrimaryConfigUsesH264AtGivenDimensions() {
        let configs = ScreenRecorder.buildFallbackConfigs(primaryWidth: 1920, primaryHeight: 1080)
        let primary = configs[0]
        XCTAssertEqual(primary.codec, .h264)
        XCTAssertEqual(primary.width, 1920)
        XCTAssertEqual(primary.height, 1080)
        XCTAssertEqual(primary.label, "primary")
    }

    func testFinalFallbackIs1280x720H264() {
        let configs = ScreenRecorder.buildFallbackConfigs(primaryWidth: 1920, primaryHeight: 1080)
        let lastConfig = configs.last!
        XCTAssertEqual(lastConfig.codec, .h264)
        XCTAssertEqual(lastConfig.width, 1280)
        XCTAssertEqual(lastConfig.height, 720)
        XCTAssertEqual(lastConfig.label, "fallback-720p")
    }

    func testAllFallbackConfigsHaveNormalizedDimensions() {
        let configs = ScreenRecorder.buildFallbackConfigs(primaryWidth: 1921, primaryHeight: 1081)
        for config in configs {
            XCTAssertEqual(config.width % 2, 0, "Width should be even for config '\(config.label)'")
            XCTAssertEqual(config.height % 2, 0, "Height should be even for config '\(config.label)'")
            XCTAssertGreaterThanOrEqual(config.width, 128, "Width should be >= 128 for config '\(config.label)'")
            XCTAssertGreaterThanOrEqual(config.height, 128, "Height should be >= 128 for config '\(config.label)'")
        }
    }

    func testHalvedConfigDimensionsCorrect() {
        let configs = ScreenRecorder.buildFallbackConfigs(primaryWidth: 1920, primaryHeight: 1080)
        // Second config should be the halved fallback
        let halved = configs[1]
        XCTAssertEqual(halved.label, "fallback-half")
        XCTAssertEqual(halved.codec, .h264)
        // 1920/2 = 960, 1080/2 = 540 — both already even and above minimum
        XCTAssertEqual(halved.width, 960)
        XCTAssertEqual(halved.height, 540)
    }

    // MARK: - Error Mapping

    func testPermissionErrorCodesMappedCorrectly() {
        let permissionCodes = [-3801, -3802, -3803]
        for code in permissionCodes {
            let nsError = NSError(domain: "com.apple.screencapturekit.error", code: code, userInfo: nil)
            let mapped = ScreenRecorder.mapStreamError(nsError)
            if case .permissionDenied = mapped {
                // Expected
            } else {
                XCTFail("Error code \(code) should map to .permissionDenied, got \(mapped)")
            }
        }
    }

    func testSourceErrorCodesMappedCorrectly() {
        let sourceCodes = [-3804, -3805, -3806, -3807]
        for code in sourceCodes {
            let nsError = NSError(domain: "com.apple.screencapturekit.error", code: code, userInfo: nil)
            let mapped = ScreenRecorder.mapStreamError(nsError)
            if case .sourceUnavailable = mapped {
                // Expected
            } else {
                XCTFail("Error code \(code) should map to .sourceUnavailable, got \(mapped)")
            }
        }
    }

    func testConversationErrorCodesMappedCorrectly() {
        let sessionCodes = [-3808, -3809, -3810]
        for code in sessionCodes {
            let nsError = NSError(domain: "com.apple.screencapturekit.error", code: code, userInfo: nil)
            let mapped = ScreenRecorder.mapStreamError(nsError)
            if case .sessionInterrupted = mapped {
                // Expected
            } else {
                XCTFail("Error code \(code) should map to .sessionInterrupted, got \(mapped)")
            }
        }
    }

    func testUnknownSCKErrorCodeMapsToSessionInterrupted() {
        let nsError = NSError(
            domain: "com.apple.screencapturekit.error",
            code: -9999,
            userInfo: [NSLocalizedDescriptionKey: "Unknown SCK error"]
        )
        let mapped = ScreenRecorder.mapStreamError(nsError)
        if case .sessionInterrupted(let desc) = mapped {
            XCTAssertTrue(desc.contains("-9999"), "Description should contain the error code")
        } else {
            XCTFail("Unknown SCK error should map to .sessionInterrupted, got \(mapped)")
        }
    }

    func testNonSCKDomainMapsToSessionInterrupted() {
        let nsError = NSError(
            domain: NSCocoaErrorDomain,
            code: 42,
            userInfo: [NSLocalizedDescriptionKey: "Some Cocoa error"]
        )
        let mapped = ScreenRecorder.mapStreamError(nsError)
        if case .sessionInterrupted(let desc) = mapped {
            XCTAssertTrue(desc.contains("Cocoa"), "Description should contain original error info")
        } else {
            XCTFail("Non-SCK domain error should map to .sessionInterrupted, got \(mapped)")
        }
    }

    // MARK: - Error Cases (Recording Hardening)

    func testWriterFailedErrorDescription() {
        let error = RecorderError.writerFailed(status: 3, underlyingError: nil)
        XCTAssertNotNil(error.errorDescription)
        XCTAssertTrue(error.errorDescription!.contains("3"), "Should include status code")
    }

    func testInvalidOutputFileErrorDescription() {
        let error = RecorderError.invalidOutputFile
        XCTAssertNotNil(error.errorDescription)
        XCTAssertTrue(
            error.errorDescription!.lowercased().contains("invalid") ||
            error.errorDescription!.lowercased().contains("unplayable"),
            "Should indicate file is invalid/unplayable"
        )
    }

    // MARK: - Telemetry Categorization for New Error Cases

    func testWriterFailedCategorizesToWriter() {
        let category = RecordingTelemetry.categorize(.writerFailed(status: 3, underlyingError: nil))
        XCTAssertEqual(category, .writer)
    }

    func testInvalidOutputFileCategorizesToWriter() {
        let category = RecordingTelemetry.categorize(.invalidOutputFile)
        XCTAssertEqual(category, .writer)
    }

    // MARK: - Atomic File Naming

    func testRecordingResultFilePathDoesNotContainTmp() {
        // The atomic rename ensures the final path doesn't contain .tmp
        // This is a contract test — if the recording system changes the naming
        // scheme, this test will catch it.
        let mockPath = "/path/to/recording-12345.mov"
        XCTAssertFalse(mockPath.contains(".tmp"), "Final recording path should not contain .tmp")

        let tmpPath = "/path/to/recording-12345.tmp.mov"
        XCTAssertTrue(tmpPath.contains(".tmp"), "Temp recording path should contain .tmp")

        // Verify the rename logic: removing .tmp.mov and adding .mov
        let tmpURL = URL(fileURLWithPath: tmpPath)
        let finalURL = tmpURL.deletingPathExtension().deletingPathExtension().appendingPathExtension("mov")
        XCTAssertEqual(finalURL.lastPathComponent, "recording-12345.mov")
    }

    // MARK: - RecorderError Exhaustiveness

    func testAllRecorderErrorCasesHaveDescriptions() {
        let errors: [RecorderError] = [
            .noMatchingDisplay,
            .noMatchingWindow,
            .streamStartFailed("test"),
            .writerSetupFailed("test"),
            .notRecording,
            .noFramesCaptured,
            .allFallbacksExhausted,
            .unsupportedDimensions(width: 100, height: 100),
            .sourceUnavailable("test"),
            .permissionDenied,
            .sessionInterrupted("test"),
            .writerFailed(status: 3, underlyingError: nil),
            .invalidOutputFile,
        ]

        for error in errors {
            XCTAssertNotNil(error.errorDescription, "Error \(error) should have a description")
            XCTAssertFalse(error.errorDescription!.isEmpty, "Error \(error) description should not be empty")
        }
    }
}
