import Foundation
import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

final class MessageInspectorMemoryTabTests: XCTestCase {

    // MARK: - No data state

    func testNilRecallProducesNoDataState() {
        let model = MessageInspectorMemoryTabModel(memoryRecall: nil)

        XCTAssertFalse(model.hasData)
        XCTAssertFalse(model.isEnabled)
        XCTAssertNil(model.disabledReason)
        XCTAssertTrue(model.statusRows.isEmpty)
        XCTAssertTrue(model.funnelRows.isEmpty)
        XCTAssertTrue(model.searchRows.isEmpty)
        XCTAssertTrue(model.candidates.isEmpty)
        XCTAssertNil(model.injectedText)
        XCTAssertNil(model.degradationReason)
    }

    // MARK: - Disabled state

    func testDisabledRecallSurfacesReasonAndSkipsAllCards() {
        let recall = makeRecall(enabled: false, reason: "Memory is turned off in settings.")
        let model = MessageInspectorMemoryTabModel(memoryRecall: recall)

        XCTAssertTrue(model.hasData)
        XCTAssertFalse(model.isEnabled)
        XCTAssertEqual(model.disabledReason, "Memory is turned off in settings.")
        XCTAssertTrue(model.statusRows.isEmpty)
        XCTAssertTrue(model.funnelRows.isEmpty)
        XCTAssertTrue(model.searchRows.isEmpty)
        XCTAssertTrue(model.candidates.isEmpty)
        XCTAssertNil(model.injectedText)
    }

    func testDisabledRecallWithNilReasonUsesFallback() {
        let recall = makeRecall(enabled: false, reason: nil)
        let model = MessageInspectorMemoryTabModel(memoryRecall: recall)

        XCTAssertEqual(model.disabledReason, "Memory recall was disabled for this turn.")
    }

    // MARK: - Enabled — status card

    func testEnabledActiveRecallProducesStatusRows() {
        let recall = makeRecall(
            enabled: true,
            degraded: false,
            provider: "qdrant",
            model: "bge-m3",
            latencyMs: 142
        )
        let model = MessageInspectorMemoryTabModel(memoryRecall: recall)

        XCTAssertTrue(model.isEnabled)
        XCTAssertEqual(model.statusRows.map(\.label), ["Status", "Provider", "Model", "Total latency"])
        XCTAssertEqual(model.statusRows[0].value, "Active")
        XCTAssertEqual(model.statusRows[1].value, "qdrant")
        XCTAssertEqual(model.statusRows[2].value, "bge-m3")
        XCTAssertEqual(model.statusRows[3].value, "142 ms")
    }

    func testDegradedStatusShowsDegradedLabel() {
        let recall = makeRecall(enabled: true, degraded: true)
        let model = MessageInspectorMemoryTabModel(memoryRecall: recall)

        XCTAssertEqual(model.statusRows.first(where: { $0.label == "Status" })?.value, "Degraded")
    }

    func testNilProviderAndModelShowUnavailable() {
        let recall = makeRecall(enabled: true, provider: nil, model: nil)
        let model = MessageInspectorMemoryTabModel(memoryRecall: recall)

        XCTAssertEqual(model.statusRows.first(where: { $0.label == "Provider" })?.value, "Unavailable")
        XCTAssertEqual(model.statusRows.first(where: { $0.label == "Model" })?.value, "Unavailable")
    }

    // MARK: - Enabled — funnel card

    func testFunnelRowsReflectRecallCounts() {
        let recall = makeRecall(
            enabled: true,
            semanticHits: 48,
            mergedCount: 32,
            selectedCount: 10,
            tier1Count: 20,
            tier2Count: 12,
            injectedTokens: 1_234
        )
        let model = MessageInspectorMemoryTabModel(memoryRecall: recall)

        XCTAssertEqual(model.funnelRows.map(\.label), [
            "Semantic hits", "After merge", "Tier 1", "Tier 2", "Selected", "Injected tokens"
        ])
        XCTAssertEqual(model.funnelRows[0].value, "48")
        XCTAssertEqual(model.funnelRows[1].value, "32")
        XCTAssertEqual(model.funnelRows[2].value, "20")
        XCTAssertEqual(model.funnelRows[3].value, "12")
        XCTAssertEqual(model.funnelRows[4].value, "10")
        XCTAssertEqual(model.funnelRows[5].value, "1,234")
    }

    // MARK: - Enabled — search details

    func testSearchDetailsReflectHybridSearchData() {
        let recall = makeRecall(
            enabled: true,
            hybridSearchLatencyMs: 87,
            sparseVectorUsed: true
        )
        let model = MessageInspectorMemoryTabModel(memoryRecall: recall)

        XCTAssertEqual(model.searchRows.map(\.label), ["Hybrid search", "Sparse vectors"])
        XCTAssertEqual(model.searchRows[0].value, "87 ms")
        XCTAssertEqual(model.searchRows[1].value, "Used")
    }

    func testSparseVectorNotUsedShowsDenseOnly() {
        let recall = makeRecall(enabled: true, sparseVectorUsed: false)
        let model = MessageInspectorMemoryTabModel(memoryRecall: recall)

        XCTAssertEqual(model.searchRows.first(where: { $0.label == "Sparse vectors" })?.value, "Dense only")
    }

    // MARK: - Enabled — candidates

    func testCandidatesSortedByFinalScoreDescending() {
        let recall = makeRecall(
            enabled: true,
            topCandidates: [
                MemoryRecallCandidate(key: "low", type: "fact", kind: "core", finalScore: 0.3, semantic: 0.2, recency: 0.5),
                MemoryRecallCandidate(key: "high", type: "preference", kind: "inferred", finalScore: 0.9, semantic: 0.8, recency: 0.7),
                MemoryRecallCandidate(key: "mid", type: "fact", kind: "core", finalScore: 0.6, semantic: 0.5, recency: 0.4),
            ]
        )
        let model = MessageInspectorMemoryTabModel(memoryRecall: recall)

        XCTAssertEqual(model.candidates.count, 3)
        XCTAssertEqual(model.candidates.map(\.key), ["high", "mid", "low"])
        XCTAssertEqual(model.candidates[0].finalScore, "0.900")
        XCTAssertEqual(model.candidates[0].semanticScore, "0.800")
        XCTAssertEqual(model.candidates[0].recencyScore, "0.700")
        XCTAssertEqual(model.candidates[0].type, "preference")
        XCTAssertEqual(model.candidates[0].kind, "inferred")
    }

    func testEmptyCandidatesProducesEmptyArray() {
        let recall = makeRecall(enabled: true, topCandidates: [])
        let model = MessageInspectorMemoryTabModel(memoryRecall: recall)

        XCTAssertTrue(model.candidates.isEmpty)
    }

    // MARK: - Enabled — injected text

    func testInjectedTextPassedThrough() {
        let recall = makeRecall(enabled: true, injectedText: "User prefers dark mode. Lives in SF.")
        let model = MessageInspectorMemoryTabModel(memoryRecall: recall)

        XCTAssertEqual(model.injectedText, "User prefers dark mode. Lives in SF.")
    }

    func testNilInjectedTextProducesNil() {
        let recall = makeRecall(enabled: true, injectedText: nil)
        let model = MessageInspectorMemoryTabModel(memoryRecall: recall)

        XCTAssertNil(model.injectedText)
    }

    // MARK: - Enabled — degradation

    func testDegradationCardPopulatedWhenPresent() {
        let degradation = MemoryRecallDegradation(
            semanticUnavailable: true,
            reason: "Qdrant index not ready",
            fallbackSources: ["recency", "frequency"]
        )
        let recall = makeRecall(enabled: true, degraded: true, degradation: degradation)
        let model = MessageInspectorMemoryTabModel(memoryRecall: recall)

        XCTAssertEqual(model.degradationReason, "Qdrant index not ready")
        XCTAssertTrue(model.degradationSemanticUnavailable)
        XCTAssertEqual(model.degradationFallbackSources, "recency, frequency")
    }

    func testNoDegradationLeavesFieldsNil() {
        let recall = makeRecall(enabled: true, degraded: false, degradation: nil)
        let model = MessageInspectorMemoryTabModel(memoryRecall: recall)

        XCTAssertNil(model.degradationReason)
        XCTAssertFalse(model.degradationSemanticUnavailable)
        XCTAssertNil(model.degradationFallbackSources)
    }

    func testEmptyFallbackSourcesProducesNil() {
        let degradation = MemoryRecallDegradation(
            semanticUnavailable: false,
            reason: "Timeout",
            fallbackSources: []
        )
        let recall = makeRecall(enabled: true, degradation: degradation)
        let model = MessageInspectorMemoryTabModel(memoryRecall: recall)

        XCTAssertEqual(model.degradationReason, "Timeout")
        XCTAssertNil(model.degradationFallbackSources)
    }

    // MARK: - Helpers

    private func makeRecall(
        enabled: Bool,
        degraded: Bool = false,
        provider: String? = "qdrant",
        model: String? = "bge-m3",
        degradation: MemoryRecallDegradation? = nil,
        semanticHits: Int = 0,
        mergedCount: Int = 0,
        selectedCount: Int = 0,
        tier1Count: Int = 0,
        tier2Count: Int = 0,
        hybridSearchLatencyMs: Int = 0,
        sparseVectorUsed: Bool = false,
        injectedTokens: Int = 0,
        latencyMs: Int = 0,
        reason: String? = nil,
        topCandidates: [MemoryRecallCandidate] = [],
        injectedText: String? = nil
    ) -> MemoryRecallData {
        MemoryRecallData(
            enabled: enabled,
            degraded: degraded,
            provider: provider,
            model: model,
            degradation: degradation,
            semanticHits: semanticHits,
            mergedCount: mergedCount,
            selectedCount: selectedCount,
            tier1Count: tier1Count,
            tier2Count: tier2Count,
            hybridSearchLatencyMs: hybridSearchLatencyMs,
            sparseVectorUsed: sparseVectorUsed,
            injectedTokens: injectedTokens,
            latencyMs: latencyMs,
            reason: reason,
            topCandidates: topCandidates,
            injectedText: injectedText
        )
    }
}
