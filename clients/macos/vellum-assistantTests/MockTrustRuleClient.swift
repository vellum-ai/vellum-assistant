import Foundation
@testable import VellumAssistantLib
@testable import VellumAssistantShared

struct CreateRuleCall {
    let tool: String
    let pattern: String
    let risk: String
    let description: String
    let scope: String
}

@MainActor
final class MockTrustRuleClient: TrustRuleClientProtocol {
    // MARK: - Spy State

    var createRuleCalls: [CreateRuleCall] = []

    // MARK: - Configurable Responses

    var createRuleError: Error?

    // MARK: - Protocol Methods

    func listRules(origin: String?, tool: String?, includeDeleted: Bool?) async throws -> [TrustRule] {
        return []
    }

    func createRule(tool: String, pattern: String, risk: String, description: String, scope: String) async throws -> TrustRule {
        createRuleCalls.append(CreateRuleCall(tool: tool, pattern: pattern, risk: risk, description: description, scope: scope))
        if let error = createRuleError { throw error }
        return TrustRule(
            id: "mock-id", tool: tool, pattern: pattern, risk: risk,
            description: description, origin: "user", userModified: false,
            deleted: false, createdAt: "", updatedAt: ""
        )
    }

    func updateRule(id: String, risk: String?, description: String?) async throws -> TrustRule {
        return TrustRule(
            id: id, tool: "", pattern: "", risk: risk ?? "low",
            description: description ?? "", origin: "user", userModified: true,
            deleted: false, createdAt: "", updatedAt: ""
        )
    }

    func deleteRule(id: String) async throws {}

    func resetRule(id: String) async throws -> TrustRule {
        return TrustRule(
            id: id, tool: "", pattern: "", risk: "low",
            description: "", origin: "user", userModified: false,
            deleted: false, createdAt: "", updatedAt: ""
        )
    }

    func suggestRule(
        tool: String,
        command: String,
        riskAssessment: (risk: String, reasoning: String, reasonDescription: String),
        scopeOptions: [(pattern: String, label: String)],
        directoryScopeOptions: [(scope: String, label: String)],
        intent: String
    ) async throws -> TrustRuleSuggestion {
        return TrustRuleSuggestion(
            pattern: "*", risk: "low", scope: nil,
            description: "", scopeOptions: [], directoryScopeOptions: nil
        )
    }
}
