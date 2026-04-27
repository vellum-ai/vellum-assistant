import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class ComposerThresholdPickerTests: XCTestCase {

    func testCanonicalConversationIdNormalizesWhitespaceAndCasing() {
        let canonical = ComposerThresholdPicker.canonicalConversationId(
            "  FACB62CB-1A24-4002-B835-9D2FF83606DE "
        )
        XCTAssertEqual(canonical, "facb62cb-1a24-4002-b835-9d2ff83606de")
    }

    func testApplyPresetSelectionUsesDaemonConversationId() async throws {
        let mock = MockThresholdClient()
        let daemonConversationId = "facb62cb-1a24-4002-b835-9d2ff83606de"

        try await ComposerThresholdPicker.applyPresetSelection(
            preset: .strict,
            globalInteractive: RiskThreshold.low.rawValue,
            assistantConversationId: daemonConversationId,
            thresholdClient: mock
        )

        XCTAssertEqual(
            mock.setCalls,
            [MockThresholdClient.SetCall(
                conversationId: daemonConversationId,
                threshold: RiskThreshold.none.rawValue
            )]
        )
        XCTAssertTrue(mock.deleteCalls.isEmpty)
    }

    func testApplyPresetSelectionClearsOverrideWhenPresetMatchesGlobal() async throws {
        let mock = MockThresholdClient()
        let daemonConversationId = "facb62cb-1a24-4002-b835-9d2ff83606de"

        try await ComposerThresholdPicker.applyPresetSelection(
            preset: .relaxed,
            globalInteractive: RiskThreshold.medium.rawValue,
            assistantConversationId: daemonConversationId,
            thresholdClient: mock
        )

        XCTAssertTrue(mock.setCalls.isEmpty)
        XCTAssertEqual(mock.deleteCalls, [daemonConversationId])
    }

    func testApplyPresetSelectionSkipsWhenConversationIdMissing() async throws {
        let mock = MockThresholdClient()
        try await ComposerThresholdPicker.applyPresetSelection(
            preset: .strict,
            globalInteractive: RiskThreshold.low.rawValue,
            assistantConversationId: nil,
            thresholdClient: mock
        )

        XCTAssertTrue(mock.setCalls.isEmpty)
        XCTAssertTrue(mock.deleteCalls.isEmpty)
    }

    func testStagedDraftOverrideStrictAndDefault() {
        let strict = ComposerThresholdPicker.stagedDraftOverride(
            for: .strict,
            globalInteractive: RiskThreshold.low.rawValue
        )
        XCTAssertEqual(strict, RiskThreshold.none.rawValue)

        let `default` = ComposerThresholdPicker.stagedDraftOverride(
            for: .default,
            globalInteractive: RiskThreshold.low.rawValue
        )
        XCTAssertNil(`default`)
    }

    func testPresetFromNoOverrideReflectsGlobalInteractiveThreshold() {
        XCTAssertEqual(
            ThresholdPreset.from(
                override: nil,
                globalInteractive: RiskThreshold.none.rawValue
            ),
            .strict
        )
        XCTAssertEqual(
            ThresholdPreset.from(
                override: nil,
                globalInteractive: RiskThreshold.low.rawValue
            ),
            .default
        )
        XCTAssertEqual(
            ThresholdPreset.from(
                override: nil,
                globalInteractive: RiskThreshold.medium.rawValue
            ),
            .relaxed
        )
        XCTAssertEqual(
            ThresholdPreset.from(
                override: nil,
                globalInteractive: RiskThreshold.high.rawValue
            ),
            .fullAccess
        )
    }

    func testPresetFromOverrideMatchingGlobalReflectsGlobalPreset() {
        XCTAssertEqual(
            ThresholdPreset.from(
                override: RiskThreshold.high.rawValue,
                globalInteractive: RiskThreshold.high.rawValue
            ),
            .fullAccess
        )
        XCTAssertEqual(
            ThresholdPreset.from(
                override: RiskThreshold.medium.rawValue,
                globalInteractive: RiskThreshold.medium.rawValue
            ),
            .relaxed
        )
    }

    func testPresetFromOverrideUsesAbsoluteThresholdValue() {
        XCTAssertEqual(
            ThresholdPreset.from(
                override: RiskThreshold.medium.rawValue,
                globalInteractive: RiskThreshold.high.rawValue
            ),
            .relaxed
        )
        XCTAssertEqual(
            ThresholdPreset.from(
                override: RiskThreshold.low.rawValue,
                globalInteractive: RiskThreshold.none.rawValue
            ),
            .default
        )
    }

    func testPresetRiskThresholdMappingRoundTrips() {
        XCTAssertEqual(ThresholdPreset.strict.riskThreshold, .none)
        XCTAssertEqual(ThresholdPreset.default.riskThreshold, .low)
        XCTAssertEqual(ThresholdPreset.relaxed.riskThreshold, .medium)
        XCTAssertEqual(ThresholdPreset.fullAccess.riskThreshold, .high)

        XCTAssertEqual(ThresholdPreset.from(riskThreshold: .none), .strict)
        XCTAssertEqual(ThresholdPreset.from(riskThreshold: .low), .default)
        XCTAssertEqual(ThresholdPreset.from(riskThreshold: .medium), .relaxed)
        XCTAssertEqual(ThresholdPreset.from(riskThreshold: .high), .fullAccess)
    }
}

private final class MockThresholdClient: ThresholdClientProtocol {
    struct SetCall: Equatable {
        let conversationId: String
        let threshold: String
    }

    private(set) var setCalls: [SetCall] = []
    private(set) var deleteCalls: [String] = []

    func getGlobalThresholds() async throws -> GlobalThresholds {
        GlobalThresholds(
            interactive: RiskThreshold.low.rawValue,
            autonomous: RiskThreshold.none.rawValue
        )
    }

    func setGlobalThresholds(_ thresholds: GlobalThresholds) async throws {}

    func getConversationOverride(conversationId: String) async throws -> String? {
        nil
    }

    func setConversationOverride(conversationId: String, threshold: String) async throws {
        setCalls.append(SetCall(conversationId: conversationId, threshold: threshold))
    }

    func deleteConversationOverride(conversationId: String) async throws {
        deleteCalls.append(conversationId)
    }
}
