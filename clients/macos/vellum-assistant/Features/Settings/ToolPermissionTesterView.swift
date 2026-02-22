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
    }

    // MARK: - Form Fields

    @ViewBuilder
    private var formFields: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            // Tool name
            fieldLabel("Tool Name")
            TextField("e.g. host_bash, host_file_write", text: $model.toolName)
                .textFieldStyle(.plain)
                .font(VFont.mono)
                .foregroundColor(VColor.textPrimary)
                .padding(VSpacing.sm)
                .background(VColor.surface)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.sm)
                        .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
                )

            // Input JSON
            fieldLabel("Input JSON")
            TextEditor(text: $model.inputJSON)
                .font(VFont.monoSmall)
                .foregroundColor(VColor.textPrimary)
                .scrollContentBackground(.hidden)
                .padding(VSpacing.xs)
                .frame(minHeight: 60, maxHeight: 120)
                .background(VColor.surface)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.sm)
                        .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
                )

            // Working directory
            fieldLabel("Working Directory")
            TextField("Leave empty for daemon default", text: $model.workingDir)
                .textFieldStyle(.plain)
                .font(VFont.mono)
                .foregroundColor(VColor.textPrimary)
                .padding(VSpacing.sm)
                .background(VColor.surface)
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

                Toggle("Force Prompt Side Effects", isOn: $model.forcePromptSideEffects)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
                    .toggleStyle(.switch)
            }

            // Execution target
            HStack(spacing: VSpacing.sm) {
                fieldLabel("Execution Target")
                Picker("", selection: $model.executionTarget) {
                    Text("None").tag("")
                    Text("Host").tag("host")
                    Text("Sandbox").tag("sandbox")
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
            }

            // Principal override
            HStack(spacing: VSpacing.sm) {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    fieldLabel("Principal Kind")
                    Picker("", selection: $model.principalKind) {
                        Text("None").tag("")
                        Text("Core").tag("core")
                        Text("Skill").tag("skill")
                        Text("Task").tag("task")
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .fixedSize()
                }

                if !model.principalKind.isEmpty {
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        fieldLabel("Principal ID")
                        TextField("e.g. my-skill", text: $model.principalId)
                            .textFieldStyle(.plain)
                            .font(VFont.monoSmall)
                            .foregroundColor(VColor.textPrimary)
                            .padding(VSpacing.xs)
                            .background(VColor.surface)
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                            .overlay(
                                RoundedRectangle(cornerRadius: VRadius.sm)
                                    .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
                            )
                    }

                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        fieldLabel("Version")
                        TextField("hash", text: $model.principalVersion)
                            .textFieldStyle(.plain)
                            .font(VFont.monoSmall)
                            .foregroundColor(VColor.textPrimary)
                            .padding(VSpacing.xs)
                            .background(VColor.surface)
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                            .overlay(
                                RoundedRectangle(cornerRadius: VRadius.sm)
                                    .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
                            )
                    }
                }
            }
        }
    }

    // MARK: - Simulate Button

    @ViewBuilder
    private var simulateButton: some View {
        HStack {
            VButton(label: model.isSimulating ? "Simulating..." : "Simulate", style: .primary) {
                model.simulate()
            }
            .disabled(model.toolName.isEmpty || model.isSimulating)

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

                // Local override label
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
