import Foundation
import Combine
import VellumAssistantShared

/// Result from a tool permission simulation.
struct SimulationResult: Equatable {
    let decision: String
    let riskLevel: String
    let reason: String
    let matchedRuleId: String?
    let promptPayload: ToolPermissionSimulateResponsePromptPayload?
    /// Transient display state set by local-only actions (allowOnce / denyOnce).
    var localOverrideLabel: String?

    // Snapshot of form values at simulation time, so the confirmation bubble
    // and "Always Allow" rule persist the values that produced this result
    // rather than whatever the user may have edited since.
    let snapshotToolName: String
    let snapshotInputJSON: String
    /// Execution target resolved by the daemon from the tool name.
    let snapshotExecutionTarget: String?

    static func == (lhs: SimulationResult, rhs: SimulationResult) -> Bool {
        lhs.decision == rhs.decision
        && lhs.riskLevel == rhs.riskLevel
        && lhs.reason == rhs.reason
        && lhs.matchedRuleId == rhs.matchedRuleId
        && lhs.localOverrideLabel == rhs.localOverrideLabel
    }
}

/// Describes a single input parameter parsed from a tool's JSON Schema.
struct ToolFieldDescriptor: Identifiable {
    let id: String
    let fieldType: FieldType
    let description: String?
    let isRequired: Bool

    enum FieldType {
        case string
        case number
        case integer
        case boolean
        case enumeration([String])
        case json
    }
}

/// View-model for the tool permission simulation tester in Settings.
///
/// Manages form fields, fires simulate requests via ToolClient,
/// and surfaces results (including prompt payloads) for the UI layer.
@MainActor
final class ToolPermissionTesterModel: ObservableObject {

    // MARK: - Form Fields

    @Published var toolName: String = ""
    @Published var workingDir: String = ""
    @Published var isInteractive: Bool = true
    @Published var forcePromptSideEffects: Bool = false

    // MARK: - Dynamic Input Fields

    /// Field descriptors for the currently selected tool, derived from its schema.
    @Published var fieldDescriptors: [ToolFieldDescriptor] = []
    /// Current values keyed by field name. String fields, numbers, and enum selections
    /// are all stored as strings; booleans stored as "true"/"false".
    @Published var fieldValues: [String: String] = [:]
    /// Whether each optional field is enabled (checked). Required fields are always enabled.
    @Published var fieldEnabled: [String: Bool] = [:]

    // MARK: - Tool Names & Schemas

    @Published var availableToolNames: [String] = []

    /// Raw schemas keyed by tool name, received from the daemon.
    private var toolSchemas: [String: Any] = [:]

    // MARK: - Result State

    @Published var isSimulating: Bool = false
    @Published var lastResult: SimulationResult?
    @Published var lastError: String?

    // MARK: - Dependencies

    private let connectionManager: GatewayConnectionManager
    private let toolClient: ToolClientProtocol
    private let trustRuleClient: TrustRuleClientProtocol
    private var cancellables = Set<AnyCancellable>()
    private var observeConnectionTask: Task<Void, Never>?

    // Snapshot of form values captured at simulate() time so
    // handleSimulateResponse uses the values that produced the request,
    // not whatever the user may have edited while the request was in flight.
    private var pendingSnapshotToolName: String = ""
    private var pendingSnapshotInputJSON: String = ""

    init(connectionManager: GatewayConnectionManager, toolClient: ToolClientProtocol = ToolClient(), trustRuleClient: TrustRuleClientProtocol = TrustRuleClient()) {
        self.connectionManager = connectionManager
        self.toolClient = toolClient
        self.trustRuleClient = trustRuleClient

        // Rebuild dynamic fields whenever the selected tool changes.
        $toolName
            .removeDuplicates()
            .sink { [weak self] name in
                self?.updateFieldsForTool(name)
            }
            .store(in: &cancellables)

        // Re-fetch tool names whenever the daemon (re)connects.
        observeConnectionTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                guard let self else { break }
                await withCheckedContinuation { (resume: CheckedContinuation<Void, Never>) in
                    withObservationTracking {
                        _ = self.connectionManager.isConnected
                    } onChange: {
                        resume.resume()
                    }
                }
                guard !Task.isCancelled, let self else { break }
                if self.connectionManager.isConnected {
                    self.fetchToolNames()
                }
            }
        }
    }

    // MARK: - Tool Names Fetching

    /// Request a fresh list of registered tool names via the gateway.
    ///
    /// Safe to call multiple times (e.g. on every `onAppear`).
    func fetchToolNames() {
        Task {
            do {
                let response = try await toolClient.fetchToolNamesList()
                self.availableToolNames = response.names
                self.toolSchemas = Self.extractSchemas(from: response.schemas ?? [:])
                if !self.toolName.isEmpty {
                    self.updateFieldsForTool(self.toolName)
                }
            } catch {
                // Fetch failed — keep previous tool names visible
            }
        }
    }

    // MARK: - Schema Parsing

    /// Extract schemas dictionary from the AnyCodable response field.
    private static func extractSchemas(from raw: [String: AnyCodable]) -> [String: Any] {
        var result: [String: Any] = [:]
        for (key, value) in raw {
            result[key] = value.value
        }
        return result
    }

    /// Rebuild field descriptors and reset values when the selected tool changes.
    private func updateFieldsForTool(_ name: String) {
        guard !name.isEmpty,
              let schemaAny = toolSchemas[name],
              let schema = schemaAny as? [String: Any],
              let properties = schema["properties"] as? [String: Any]
        else {
            fieldDescriptors = []
            fieldValues = [:]
            fieldEnabled = [:]
            return
        }

        let requiredNames = Set((schema["required"] as? [String]) ?? [])
        var descriptors: [ToolFieldDescriptor] = []

        // Sort properties alphabetically, but put required fields first.
        let sortedKeys = properties.keys.sorted { a, b in
            let aReq = requiredNames.contains(a)
            let bReq = requiredNames.contains(b)
            if aReq != bReq { return aReq }
            return a < b
        }

        for key in sortedKeys {
            guard let propAny = properties[key] else { continue }
            let prop = propAny as? [String: Any] ?? [:]
            let isRequired = requiredNames.contains(key)
            let description = prop["description"] as? String

            let fieldType: ToolFieldDescriptor.FieldType
            if let enumValues = prop["enum"] as? [String] {
                fieldType = .enumeration(enumValues)
            } else {
                let typeStr = prop["type"] as? String ?? "string"
                switch typeStr {
                case "boolean": fieldType = .boolean
                case "number": fieldType = .number
                case "integer": fieldType = .integer
                case "object", "array": fieldType = .json
                default: fieldType = .string
                }
            }

            descriptors.append(ToolFieldDescriptor(
                id: key,
                fieldType: fieldType,
                description: description,
                isRequired: isRequired
            ))
        }

        fieldDescriptors = descriptors

        // Reset values: keep existing values for fields that still exist,
        // add defaults for new fields.
        var newValues: [String: String] = [:]
        var newEnabled: [String: Bool] = [:]
        for desc in descriptors {
            if let existing = fieldValues[desc.id] {
                newValues[desc.id] = existing
            } else {
                switch desc.fieldType {
                case .boolean:
                    newValues[desc.id] = "false"
                default:
                    newValues[desc.id] = ""
                }
            }
            newEnabled[desc.id] = fieldEnabled[desc.id] ?? desc.isRequired
        }
        fieldValues = newValues
        fieldEnabled = newEnabled
    }

    // MARK: - Validation

    /// Whether the form is valid for simulation. False when the tool name is
    /// empty or any required field has an empty/unparseable value.
    var canSimulate: Bool {
        guard !toolName.isEmpty, !isSimulating else { return false }
        for field in fieldDescriptors {
            guard field.isRequired else { continue }
            let value = fieldValues[field.id] ?? ""
            switch field.fieldType {
            case .boolean:
                // Always valid — stored as "true"/"false"
                continue
            case .number:
                if Double(value) == nil { return false }
            case .integer:
                if Int(value) == nil { return false }
            case .enumeration:
                if value.isEmpty { return false }
            case .json:
                guard !value.isEmpty,
                      let data = value.data(using: .utf8),
                      (try? JSONSerialization.jsonObject(with: data)) != nil
                else { return false }
            case .string:
                // Strings are always valid (empty string is a legitimate value)
                continue
            }
        }
        return true
    }

    // MARK: - Building Input

    /// Build the input dictionary from the dynamic field values.
    func buildInputFromFields() -> [String: AnyCodable] {
        var result: [String: AnyCodable] = [:]
        for field in fieldDescriptors {
            // Skip disabled optional fields
            if !field.isRequired && !(fieldEnabled[field.id] ?? false) {
                continue
            }
            let value = fieldValues[field.id] ?? ""

            switch field.fieldType {
            case .string:
                result[field.id] = AnyCodable(value)
            case .number:
                if let num = Double(value) {
                    result[field.id] = AnyCodable(num)
                } else if !value.isEmpty {
                    result[field.id] = AnyCodable(value)
                }
            case .integer:
                if let num = Int(value) {
                    result[field.id] = AnyCodable(num)
                } else if !value.isEmpty {
                    result[field.id] = AnyCodable(value)
                }
            case .boolean:
                result[field.id] = AnyCodable(value == "true")
            case .enumeration:
                if !value.isEmpty {
                    result[field.id] = AnyCodable(value)
                }
            case .json:
                if !value.isEmpty,
                   let data = value.data(using: .utf8),
                   let parsed = try? JSONSerialization.jsonObject(with: data) {
                    result[field.id] = AnyCodable(parsed)
                }
            }
        }
        return result
    }

    /// Serialize the current field values to a JSON string for snapshots.
    private func buildInputJSONString() -> String {
        let input = buildInputFromFields()
        guard !input.isEmpty else { return "{}" }
        do {
            let data = try JSONEncoder().encode(input)
            return String(data: data, encoding: .utf8) ?? "{}"
        } catch {
            return "{}"
        }
    }

    // MARK: - Actions

    /// Build input from fields, send a simulate request via the gateway, and update result state.
    func simulate() {
        lastError = nil
        lastResult = nil

        let parsed = buildInputFromFields()
        isSimulating = true

        // Capture form values now so the snapshot reflects the state at
        // request time, not at response time (the user may edit the form
        // while the HTTP round-trip is in flight).
        pendingSnapshotToolName = toolName
        pendingSnapshotInputJSON = buildInputJSONString()

        Task {
            do {
                let response = try await toolClient.simulateToolPermission(
                    toolName: toolName,
                    input: parsed,
                    workingDir: workingDir.isEmpty ? nil : workingDir,
                    isInteractive: isInteractive,
                    forcePromptSideEffects: forcePromptSideEffects
                )
                handleSimulateResponse(response)
            } catch {
                isSimulating = false
                lastError = "Simulate failed: \(error.localizedDescription)"
            }
        }
    }

    /// Local-only: mark the simulation result as "allowed" without touching the daemon.
    func allowOnce() {
        guard var result = lastResult else { return }
        result.localOverrideLabel = "Allowed (simulation)"
        lastResult = result
    }

    /// Local-only: mark the simulation result as "denied" without touching the daemon.
    func denyOnce() {
        guard var result = lastResult else { return }
        result.localOverrideLabel = "Denied (simulation)"
        lastResult = result
    }

    /// Persist a trust rule via the gateway, then re-simulate to show updated decision.
    ///
    /// Uses the snapshot captured at simulation time so the persisted rule
    /// matches the context that produced the prompt, not whatever the user
    /// may have edited in the form since then.
    func alwaysAllow(pattern: String, scope: String) {
        guard let snapshot = lastResult else {
            lastError = "Cannot add trust rule: no simulation result"
            return
        }

        let isHighRisk = snapshot.riskLevel.lowercased() == "high"

        Task {
            do {
                try await trustRuleClient.addTrustRule(
                    toolName: snapshot.snapshotToolName,
                    pattern: pattern,
                    scope: scope,
                    decision: "allow",
                    allowHighRisk: isHighRisk ? true : nil,
                    executionTarget: snapshot.snapshotExecutionTarget
                )
                // Re-simulate to show the updated outcome with the new rule in effect.
                simulate()
            } catch {
                lastError = "Failed to add trust rule: \(error.localizedDescription)"
            }
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
            snapshotExecutionTarget: response.executionTarget
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
