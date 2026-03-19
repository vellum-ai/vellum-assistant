import SwiftUI
import VellumAssistantShared

/// Simulator form for testing tool permission decisions without executing real tools.
struct ToolPermissionTesterView: View {
    @ObservedObject var model: ToolPermissionTesterModel

    var body: some View {
        SettingsCard(title: "Permission Simulator", subtitle: "Test how a tool invocation would be evaluated by the permission system.") {
            formFields

            simulateButton

            resultSection
        }
        .onAppear {
            model.fetchToolNames()
        }
    }

    // MARK: - Form Fields

    @ViewBuilder
    private var formFields: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            // Tool name
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                fieldLabel("Tool Name")
                toolNamePicker
            }

            // Dynamic input fields based on schema
            toolInputFields

            // Working directory
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                fieldLabel("Working Directory")
                TextField("Leave empty for assistant default", text: $model.workingDir)
                    .vInputStyle(maxWidth: .infinity)
                    .font(VFont.mono)
            }

            // Toggles
            HStack(spacing: VSpacing.xl) {
                VToggle(isOn: $model.isInteractive, label: "Interactive")
                    .font(VFont.body)
                    .foregroundColor(VColor.contentSecondary)

                VToggle(isOn: $model.forcePromptSideEffects, label: "In Temporary Chat")
                    .font(VFont.body)
                    .foregroundColor(VColor.contentSecondary)
            }
        }
    }

    // MARK: - Dynamic Tool Input Fields

    @ViewBuilder
    private var toolInputFields: some View {
        if !model.fieldDescriptors.isEmpty {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                fieldLabel("Parameters")

                ForEach(model.fieldDescriptors) { field in
                    toolFieldRow(field)
                }
            }
        }
    }

    @ViewBuilder
    private func toolFieldRow(_ field: ToolFieldDescriptor) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            if field.isRequired {
                // Required fields are always shown
                fieldNameLabel(field)
                toolFieldInput(field)
            } else {
                // Optional fields have a checkbox
                HStack(spacing: VSpacing.xs) {
                    VToggle(isOn: fieldEnabledBinding(for: field.id))
                    fieldNameLabel(field)
                }

                if model.fieldEnabled[field.id] == true {
                    toolFieldInput(field)
                }
            }
        }
    }

    @ViewBuilder
    private func fieldNameLabel(_ field: ToolFieldDescriptor) -> some View {
        HStack(spacing: VSpacing.xs) {
            Text(field.id)
                .font(VFont.monoSmall)
                .foregroundColor(VColor.contentDefault)

            if field.isRequired {
                Text("*")
                    .font(VFont.captionMedium)
                    .foregroundColor(VColor.systemNegativeStrong)
            }

            if let desc = field.description {
                Text(desc)
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
    }

    @ViewBuilder
    private func toolFieldInput(_ field: ToolFieldDescriptor) -> some View {
        switch field.fieldType {
        case .string:
            TextField("", text: fieldValueBinding(for: field.id))
                .vInputStyle(maxWidth: .infinity)
                .font(VFont.mono)

        case .number, .integer:
            TextField("", text: fieldValueBinding(for: field.id))
                .vInputStyle(maxWidth: .infinity)
                .font(VFont.mono)

        case .boolean:
            VToggle(isOn: fieldBoolBinding(for: field.id))

        case .enumeration(let values):
            VDropdown(
                placeholder: "Select\u{2026}",
                selection: fieldValueBinding(for: field.id),
                options: values.map { (label: $0, value: $0) },
                emptyValue: ""
            )

        case .json:
            TextEditor(text: fieldValueBinding(for: field.id))
                .font(VFont.mono)
                .foregroundColor(VColor.contentDefault)
                .scrollContentBackground(.hidden)
                .frame(minHeight: 60, maxHeight: 120)
                .padding(VSpacing.sm)
                .background(VColor.surfaceActive)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.sm)
                        .stroke(VColor.borderBase.opacity(0.5), lineWidth: 1)
                )
        }
    }

    // MARK: - Bindings

    private func fieldValueBinding(for key: String) -> Binding<String> {
        Binding(
            get: { model.fieldValues[key] ?? "" },
            set: { model.fieldValues[key] = $0 }
        )
    }

    private func fieldEnabledBinding(for key: String) -> Binding<Bool> {
        Binding(
            get: { model.fieldEnabled[key] ?? false },
            set: { model.fieldEnabled[key] = $0 }
        )
    }

    private func fieldBoolBinding(for key: String) -> Binding<Bool> {
        Binding(
            get: { model.fieldValues[key] == "true" },
            set: { model.fieldValues[key] = $0 ? "true" : "false" }
        )
    }

    // MARK: - Simulate Button

    @ViewBuilder
    private var simulateButton: some View {
        HStack(spacing: VSpacing.sm) {
            VButton(label: model.isSimulating ? "Simulating\u{2026}" : "Simulate", style: .primary, isDisabled: !model.canSimulate) {
                model.simulate()
            }

            if model.isSimulating {
                ProgressView()
                    .controlSize(.small)
            }
        }
    }

    // MARK: - Result Section

    @ViewBuilder
    private var resultSection: some View {
        if let error = model.lastError {
            HStack(spacing: VSpacing.sm) {
                VIconView(.triangleAlert, size: 12)
                    .foregroundColor(VColor.systemNegativeStrong)
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.systemNegativeStrong)
            }
            .textSelection(.enabled)
        }

        if let result = model.lastResult {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                SettingsDivider()

                // Decision badge row
                HStack(spacing: VSpacing.sm) {
                    decisionBadge(result.decision)

                    VBadge(
                        style: .label(result.riskLevel.capitalized),
                        color: riskColor(result.riskLevel)
                    )

                    if let ruleId = result.matchedRuleId {
                        Text("Rule: \(ruleId)")
                            .font(VFont.monoSmall)
                            .foregroundColor(VColor.contentTertiary)
                    }

                    Spacer()
                }

                // Reason
                if !result.reason.isEmpty {
                    Text(result.reason)
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentSecondary)
                }

                // Prompt preview: reuse the ToolConfirmationBubble from chat
                if result.decision == "prompt",
                   result.localOverrideLabel == nil,
                   let payload = result.promptPayload {
                    let parsed = (try? model.parseInputJSON(result.snapshotInputJSON)) ?? [:]
                    let confirmation = ToolConfirmationData.fromSimulation(
                        toolName: result.snapshotToolName,
                        input: parsed,
                        riskLevel: result.riskLevel,
                        executionTarget: result.snapshotExecutionTarget,
                        promptPayload: payload
                    )

                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        ToolConfirmationBubble(
                            confirmation: confirmation,
                            isKeyboardActive: false,
                            onAllow: { model.allowOnce() },
                            onDeny: { model.denyOnce() },
                            onAlwaysAllow: { _, pattern, scope, _ in
                                model.alwaysAllow(pattern: pattern, scope: scope)
                            }
                        )

                        Text("Allow Once and Don\u{2019}t Allow are simulation-only. Always Allow persists a real trust rule.")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                            .italic()
                    }
                }

                // Local override label (shown after allowOnce / denyOnce)
                if let label = result.localOverrideLabel {
                    HStack(spacing: VSpacing.xs) {
                        VIconView(.info, size: 11)
                            .foregroundColor(VColor.contentTertiary)
                        Text(label)
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                            .italic()
                    }
                }
            }
            .textSelection(.enabled)
        }
    }

    // MARK: - Helpers

    @ViewBuilder
    private var toolNamePicker: some View {
        if model.availableToolNames.isEmpty {
            // Fallback to text field while loading or if fetch failed
            TextField("e.g. host_bash, host_file_write", text: $model.toolName)
                .vInputStyle(maxWidth: .infinity)
                .font(VFont.mono)
        } else {
            VDropdown(
                placeholder: "Select a Tool\u{2026}",
                selection: $model.toolName,
                options: model.availableToolNames.map { (label: $0, value: $0) },
                emptyValue: ""
            )
        }
    }

    private func fieldLabel(_ text: String) -> some View {
        Text(text)
            .font(VFont.inputLabel)
            .foregroundColor(VColor.contentSecondary)
    }

    @ViewBuilder
    private func decisionBadge(_ decision: String) -> some View {
        let (color, icon): (Color, VIcon) = {
            switch decision.lowercased() {
            case "allow": return (VColor.systemPositiveStrong, .circleCheck)
            case "deny": return (VColor.systemNegativeStrong, .circleX)
            case "prompt": return (VColor.systemNegativeHover, .info)
            default: return (VColor.contentTertiary, .circle)
            }
        }()

        HStack(spacing: VSpacing.xs) {
            VIconView(icon, size: 12)
                .foregroundColor(color)
            Text(decision.capitalized)
                .font(VFont.captionMedium)
                .foregroundColor(color)
        }
    }

    private func riskColor(_ level: String) -> Color {
        switch level.lowercased() {
        case "low": return VColor.contentTertiary
        case "medium": return VColor.systemNegativeHover
        case "high": return VColor.systemNegativeStrong
        default: return VColor.contentTertiary
        }
    }
}
