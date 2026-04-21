import Foundation
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class MockTrustRuleClient: TrustRuleClientProtocol {
    // MARK: - Spy State

    var addTrustRuleCalls: [(toolName: String, pattern: String, scope: String, decision: String, executionTarget: String?)] = []
    var removeTrustRuleCalls: [String] = []
    var updateTrustRuleCalls: [(id: String, tool: String?, pattern: String?, scope: String?, decision: String?, priority: Int?)] = []
    var fetchTrustRulesCallCount = 0

    // MARK: - Configurable Responses

    var fetchTrustRulesResponse: [TrustRuleItem] = []
    var fetchTrustRulesError: Error?
    var addTrustRuleError: Error?
    var removeTrustRuleError: Error?
    var updateTrustRuleError: Error?

    // MARK: - Protocol Methods

    func fetchTrustRules() async throws -> [TrustRuleItem] {
        fetchTrustRulesCallCount += 1
        if let error = fetchTrustRulesError { throw error }
        return fetchTrustRulesResponse
    }

    func addTrustRule(
        toolName: String,
        pattern: String,
        scope: String,
        decision: String,
        executionTarget: String?
    ) async throws {
        addTrustRuleCalls.append((toolName, pattern, scope, decision, executionTarget))
        if let error = addTrustRuleError { throw error }
    }

    func removeTrustRule(id: String) async throws {
        removeTrustRuleCalls.append(id)
        if let error = removeTrustRuleError { throw error }
    }

    func updateTrustRule(
        id: String,
        tool: String?,
        pattern: String?,
        scope: String?,
        decision: String?,
        priority: Int?
    ) async throws {
        updateTrustRuleCalls.append((id, tool, pattern, scope, decision, priority))
        if let error = updateTrustRuleError { throw error }
    }
}
