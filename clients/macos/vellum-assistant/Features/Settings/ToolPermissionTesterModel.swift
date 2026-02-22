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

    // Snapshot of form values at simulation time, so the confirmation bubble
    // and "Always Allow" rule persist the values that produced this result
    // rather than whatever the user may have edited since.
    let snapshotToolName: String
    let snapshotInputJSON: String
    let snapshotExecutionTarget: String

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

    // MARK: - Result State

    @Published var isSimulating: Bool = false
    @Published var lastResult: SimulationResult?
    @Published var lastError: String?

    // MARK: - Dependencies

    private let daemonClient: DaemonClientProtocol

    // Snapshot of form values captured at simulate() time so
    // handleSimulateResponse uses the values that produced the request,
    // not whatever the user may have edited while the request was in flight.
    private var pendingSnapshotToolName: String = ""
    private var pendingSnapshotInputJSON: String = ""
    private var pendingSnapshotExecutionTarget: String = ""

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

        // Capture form values now so the snapshot reflects the state at
        // request time, not at response time (the user may edit the form
        // while the IPC round-trip is in flight).
        pendingSnapshotToolName = toolName
        pendingSnapshotInputJSON = inputJSON
        pendingSnapshotExecutionTarget = executionTarget

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
    /// Uses the snapshot captured at simulation time so the persisted rule
    /// matches the context that produced the prompt, not whatever the user
    /// may have edited in the form since then.
    func alwaysAllow(pattern: String, scope: String) {
        guard let dc = daemonClient as? DaemonClient else {
            lastError = "Cannot add trust rule: daemon client unavailable"
            return
        }

        guard let snapshot = lastResult else {
            lastError = "Cannot add trust rule: no simulation result"
            return
        }

        let isHighRisk = snapshot.riskLevel.lowercased() == "high"

        do {
            try dc.sendAddTrustRule(
                toolName: snapshot.snapshotToolName,
                pattern: pattern,
                scope: scope,
                decision: "allow",
                allowHighRisk: isHighRisk ? true : nil,
                executionTarget: snapshot.snapshotExecutionTarget.isEmpty ? nil : snapshot.snapshotExecutionTarget
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
            promptPayload: response.promptPayload,
            snapshotToolName: pendingSnapshotToolName,
            snapshotInputJSON: pendingSnapshotInputJSON,
            snapshotExecutionTarget: pendingSnapshotExecutionTarget
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
