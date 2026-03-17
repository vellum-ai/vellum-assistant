import Foundation
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class MockToolClient: ToolClientProtocol {
    // MARK: - Spy State

    var fetchToolNamesListCallCount = 0
    var simulateToolPermissionCalls: [(toolName: String, input: [String: AnyCodable], workingDir: String?, isInteractive: Bool?, forcePromptSideEffects: Bool?)] = []

    // MARK: - Configurable Responses

    var toolNamesListResponse: ToolNamesListResponseMessage?
    var toolNamesListError: Error?
    var simulateResponse: ToolPermissionSimulateResponseMessage?
    var simulateError: Error?

    // MARK: - Protocol Methods

    func fetchToolNamesList() async throws -> ToolNamesListResponseMessage {
        fetchToolNamesListCallCount += 1
        if let error = toolNamesListError { throw error }
        guard let response = toolNamesListResponse else {
            throw NSError(domain: "MockToolClient", code: 0, userInfo: [NSLocalizedDescriptionKey: "No mock response configured"])
        }
        return response
    }

    func simulateToolPermission(
        toolName: String,
        input: [String: AnyCodable],
        workingDir: String?,
        isInteractive: Bool?,
        forcePromptSideEffects: Bool?
    ) async throws -> ToolPermissionSimulateResponseMessage {
        simulateToolPermissionCalls.append((toolName, input, workingDir, isInteractive, forcePromptSideEffects))
        if let error = simulateError { throw error }
        guard let response = simulateResponse else {
            throw NSError(domain: "MockToolClient", code: 0, userInfo: [NSLocalizedDescriptionKey: "No mock response configured"])
        }
        return response
    }
}
