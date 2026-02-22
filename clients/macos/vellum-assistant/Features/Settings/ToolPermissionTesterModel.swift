import Foundation
import Combine
import VellumAssistantShared

/// Result from a tool permission simulation.
struct SimulationResult: Equatable {
    let decision: String
    let riskLevel: String
    let reason: String
    let matchedRuleId: String?
    let promptPayload: IPCToolPermissionSimulateResponsePromptPayload?
    /// Transient display state set by local-only actions (allowOnce / denyOnce).
    var localOverrideLabel: String?

    static func == (lhs: SimulationResult, rhs: SimulationResult) -> Bool {
        lhs.decision == rhs.decision
        && lhs.riskLevel == rhs.riskLevel
        && lhs.reason == rhs.reason
        && lhs.matchedRuleId == rhs.matchedRuleId
        && lhs.localOverrideLabel == rhs.localOverrideLabel
    }
}

/// View-model for the tool permission simulation tester in Settings.
///
/// Manages form fields, fires simulate requests via DaemonClient,
/// and surfaces results (including prompt payloads) for the UI layer.
@MainActor
final class ToolPermissionTesterModel: ObservableObject {

    // MARK: - Form Fields

    @Published var toolName: String = ""
    @Published var inputJSON: String = "{}"
    @Published var workingDir: String = ""
    @Published var isInteractive: Bool = true
    @Published var forcePromptSideEffects: Bool = false
    @Published var executionTarget: String = ""
    @Published var principalKind: String = ""
    @Published var principalId: String = ""
    @Published var principalVersion: String = ""

    // MARK: - Result State

    @Published var isSimulating: Bool = false
    @Published var lastResult: SimulationResult?
    @Published var lastError: String?

    // MARK: - Dependencies

    private let daemonClient: DaemonClientProtocol

    init(daemonClient: DaemonClientProtocol) {
        self.daemonClient = daemonClient
    }

    // MARK: - Actions

    /// Parse inputJSON, send a simulate request via IPC, and update result state.
    func simulate() {
        lastError = nil
        lastResult = nil

        let parsed: [String: AnyCodable]
        do {
            parsed = try parseInputJSON(inputJSON)
        } catch {
            lastError = "Invalid JSON: \(error.localizedDescription)"
            return
        }

        isSimulating = true

        // Wire up the one-shot response callback before sending.
        if let dc = daemonClient as? DaemonClient {
            dc.onToolPermissionSimulateResponse = { [weak self] response in
                Task { @MainActor [weak self] in
                    self?.handleSimulateResponse(response)
                }
            }
        }

        do {
            try daemonClient.send(ToolPermissionSimulateMessage(
                toolName: toolName,
                input: parsed,
                workingDir: workingDir.isEmpty ? nil : workingDir,
                isInteractive: isInteractive,
                forcePromptSideEffects: forcePromptSideEffects,
                principalKind: principalKind.isEmpty ? nil : principalKind,
                principalId: principalId.isEmpty ? nil : principalId,
                principalVersion: principalVersion.isEmpty ? nil : principalVersion,
                executionTarget: executionTarget.isEmpty ? nil : executionTarget
            ))
        } catch {
            isSimulating = false
            lastError = "Send failed: \(error.localizedDescription)"
        }
    }

    /// Local-only: mark the simulation result as "allowed" without touching IPC.
    func allowOnce() {
        guard var result = lastResult else { return }
        result.localOverrideLabel = "Allowed (simulation)"
        lastResult = result
    }

    /// Local-only: mark the simulation result as "denied" without touching IPC.
    func denyOnce() {
        guard var result = lastResult else { return }
        result.localOverrideLabel = "Denied (simulation)"
        lastResult = result
    }

    /// Persist a trust rule via IPC, then re-simulate to show updated decision.
    ///
    /// Forwards the simulation's metadata (execution target, principal) so the
    /// persisted rule matches the context that was being tested.
    func alwaysAllow(pattern: String, scope: String, decision: String) {
        guard let dc = daemonClient as? DaemonClient else {
            lastError = "Cannot add trust rule: daemon client unavailable"
            return
        }

        let riskLevel = lastResult?.riskLevel ?? ""
        let isHighRisk = riskLevel.lowercased() == "high"

        do {
            try dc.sendAddTrustRule(
                toolName: toolName,
                pattern: pattern,
                scope: scope,
                decision: "allow",  // Always use canonical "allow" — metadata handles high-risk
                allowHighRisk: isHighRisk ? true : nil,
                principalKind: principalKind.isEmpty ? nil : principalKind,
                principalId: principalId.isEmpty ? nil : principalId,
                principalVersion: principalVersion.isEmpty ? nil : principalVersion,
                executionTarget: executionTarget.isEmpty ? nil : executionTarget
            )
            // Re-simulate to show the updated outcome with the new rule in effect.
            simulate()
        } catch {
            lastError = "Failed to add trust rule: \(error.localizedDescription)"
        }
    }

    // MARK: - Response Handling

    private func handleSimulateResponse(_ response: ToolPermissionSimulateResponseMessage) {
        isSimulating = false

        guard response.success else {
            lastError = response.error ?? "Simulation failed"
            return
        }

        lastResult = SimulationResult(
            decision: response.decision ?? "unknown",
            riskLevel: response.riskLevel ?? "unknown",
            reason: response.reason ?? "",
            matchedRuleId: response.matchedRuleId,
            promptPayload: response.promptPayload
        )
    }

    // MARK: - Helpers

    /// Parse a JSON string into a `[String: AnyCodable]` dictionary.
    func parseInputJSON(_ json: String) throws -> [String: AnyCodable] {
        let trimmed = json.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [:] }

        let data = Data(trimmed.utf8)
        let decoded = try JSONDecoder().decode([String: AnyCodable].self, from: data)
        return decoded
    }
}
