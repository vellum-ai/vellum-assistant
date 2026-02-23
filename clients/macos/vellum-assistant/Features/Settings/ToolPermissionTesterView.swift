import SwiftUI
import VellumAssistantShared

/// Simulator form for testing tool permission decisions without executing real tools.
struct ToolPermissionTesterView: View {
    @ObservedObject var model: ToolPermissionTesterModel

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Permission Simulator")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            Text("Test how a tool invocation would be evaluated by the permission system.")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)

            formFields

            simulateButton

            resultSection
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
        .onAppear {
            model.fetchToolNames()
        }
    }

    // MARK: - Form Fields

    @ViewBuilder
    private var formFields: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            // Tool name
            fieldLabel("Tool Name")
            toolNamePicker

            // Dynamic input fields based on schema
            toolInputFields

            // Working directory
            fieldLabel("Working Directory")
            TextField("Leave empty for daemon default", text: $model.workingDir)
                .textFieldStyle(.plain)
                .font(VFont.mono)
                .foregroundColor(VColor.textPrimary)
                .padding(VSpacing.sm)
                .background(VColor.inputBackground)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.sm)
                        .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
                )

            // Toggles
            HStack(spacing: VSpacing.lg) {
                Toggle("Interactive", isOn: $model.isInteractive)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
                    .toggleStyle(.switch)

                Toggle("In Temporary Chat", isOn: $model.forcePromptSideEffects)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
                    .toggleStyle(.switch)
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
                    Toggle(isOn: fieldEnabledBinding(for: field.id)) {
                        fieldNameLabel(field)
                    }
                    .toggleStyle(.checkbox)
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
                .foregroundColor(VColor.textPrimary)

            if field.isRequired {
                Text("*")
                    .font(VFont.captionMedium)
                    .foregroundColor(VColor.error)
            }

            if let desc = field.description {
                Text(desc)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
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
                .textFieldStyle(.plain)
                .font(VFont.mono)
                .foregroundColor(VColor.textPrimary)
                .padding(VSpacing.sm)
                .background(VColor.inputBackground)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.sm)
                        .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
                )

        case .number, .integer:
            TextField("", text: fieldValueBinding(for: field.id))
                .textFieldStyle(.plain)
                .font(VFont.mono)
                .foregroundColor(VColor.textPrimary)
                .padding(VSpacing.sm)
                .background(VColor.inputBackground)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.sm)
                        .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
                )

        case .boolean:
            Toggle("", isOn: fieldBoolBinding(for: field.id))
                .toggleStyle(.switch)
                .labelsHidden()

        case .enumeration(let values):
            Picker("", selection: fieldValueBinding(for: field.id)) {
                Text("Select\u{2026}")
                    .foregroundColor(VColor.textMuted)
                    .tag("")
                ForEach(values, id: \.self) { value in
                    Text(value)
                        .font(VFont.mono)
                        .tag(value)
                }
            }
            .labelsHidden()
            .font(VFont.mono)
            .padding(.vertical, VSpacing.xs)
            .padding(.horizontal, VSpacing.sm)
            .background(VColor.inputBackground)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.sm)
                    .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
            )

        case .json:
            TextEditor(text: fieldValueBinding(for: field.id))
                .font(VFont.mono)
                .foregroundColor(VColor.textPrimary)
                .scrollContentBackground(.hidden)
                .frame(minHeight: 60, maxHeight: 120)
                .padding(VSpacing.sm)
                .background(VColor.inputBackground)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.sm)
                        .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
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
        HStack {
            VButton(label: model.isSimulating ? "Simulating..." : "Simulate", style: .primary) {
                model.simulate()
            }
            .disabled(!model.canSimulate)

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
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundColor(VColor.error)
                    .font(.system(size: 12))
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
            }
        }

        if let result = model.lastResult {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                Divider().background(VColor.surfaceBorder)

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
                            .foregroundColor(VColor.textMuted)
                    }

                    Spacer()
                }

                // Reason
                if !result.reason.isEmpty {
                    Text(result.reason)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
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
                            .foregroundColor(VColor.textMuted)
                            .italic()
                    }
                }

                // Local override label (shown after allowOnce / denyOnce)
                if let label = result.localOverrideLabel {
                    HStack(spacing: VSpacing.xs) {
                        Image(systemName: "info.circle")
                            .font(.system(size: 11))
                            .foregroundColor(VColor.textMuted)
                        Text(label)
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                            .italic()
                    }
                }
            }
        }
    }

    // MARK: - Helpers

    @ViewBuilder
    private var toolNamePicker: some View {
        if model.availableToolNames.isEmpty {
            // Fallback to text field while loading or if fetch failed
            TextField("e.g. host_bash, host_file_write", text: $model.toolName)
                .textFieldStyle(.plain)
                .font(VFont.mono)
                .foregroundColor(VColor.textPrimary)
                .padding(VSpacing.sm)
                .background(VColor.inputBackground)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.sm)
                        .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
                )
        } else {
            Picker("", selection: $model.toolName) {
                Text("Select a tool\u{2026}")
                    .foregroundColor(VColor.textMuted)
                    .tag("")
                ForEach(model.availableToolNames, id: \.self) { name in
                    Text(name)
                        .font(VFont.mono)
                        .tag(name)
                }
            }
            .labelsHidden()
            .font(VFont.mono)
            .padding(.vertical, VSpacing.xs)
            .padding(.horizontal, VSpacing.sm)
            .background(VColor.inputBackground)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.sm)
                    .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
            )
        }
    }

    private func fieldLabel(_ text: String) -> some View {
        Text(text)
            .font(VFont.captionMedium)
            .foregroundColor(VColor.textSecondary)
    }

    @ViewBuilder
    private func decisionBadge(_ decision: String) -> some View {
        let (color, icon): (Color, String) = {
            switch decision.lowercased() {
            case "allow": return (VColor.success, "checkmark.circle.fill")
            case "deny": return (VColor.error, "xmark.circle.fill")
            case "prompt": return (VColor.warning, "questionmark.circle.fill")
            default: return (VColor.textMuted, "circle")
            }
        }()

        HStack(spacing: VSpacing.xs) {
            Image(systemName: icon)
                .font(.system(size: 12))
                .foregroundColor(color)
            Text(decision.capitalized)
                .font(VFont.captionMedium)
                .foregroundColor(color)
        }
    }

    private func riskColor(_ level: String) -> Color {
        switch level.lowercased() {
        case "low": return VColor.textMuted
        case "medium": return VColor.warning
        case "high": return VColor.error
        default: return VColor.textMuted
        }
    }
}
