import SwiftUI
import VellumAssistantShared

// MARK: - Helper Types

struct V3ScopeOptionItem: Identifiable, Equatable {
    let id = UUID()
    let label: String
    let pattern: String
}

struct V3SavedRule {
    let toolName: String
    let pattern: String
    let riskLevel: String
    let scope: String
}

// MARK: - V3RuleEditorModal

/// V3 Rule Editor Modal — minimal, focused on generalization and risk assessment.
/// Shows only the generalized pattern options (skips exact match) and risk level picker.
struct V3RuleEditorModal: View {
    /// Raw tool identifier (e.g. "bash", "host_bash") used for trust rule persistence.
    let toolName: String
    let commandText: String
    let commandDescription: String
    let riskLevel: String
    let scopeOptions: [V3ScopeOptionItem]
    let onSave: (V3SavedRule) -> Void
    let onDismiss: () -> Void

    @State private var selectedPatternIndex: Int = 1 // Start from first generalization (skip exact match at index 0)
    @State private var selectedRiskLevel: String = "medium"
    @State private var isSaving: Bool = false

    /// Generalized pattern options.
    /// If scopeOptions has multiple elements, skip the exact match at index 0.
    /// If scopeOptions has only 1 element (single wildcard), show it directly.
    private var generalizedOptions: [V3ScopeOptionItem] {
        scopeOptions.count > 1 ? Array(scopeOptions.dropFirst()) : scopeOptions
    }

    /// Whether we're showing a single wildcard option (not skipping index 0)
    private var isSingleOption: Bool {
        scopeOptions.count == 1
    }

    /// Contextual hint for the selected risk level
    private var riskLevelHint: String {
        switch selectedRiskLevel.lowercased() {
        case "low":
            return "Auto-approved under most permission settings"
        case "medium":
            return "Auto-approved under permissive settings"
        case "high":
            return "Requires explicit approval in most configurations"
        default:
            return ""
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            HStack {
                Text("Create Trust Rule")
                    .font(VFont.titleSmall)
                    .foregroundStyle(VColor.contentDefault)
                Spacer(minLength: 0)
                VButton(
                    label: "Close",
                    iconOnly: VIcon.x.rawValue,
                    style: .ghost,
                    tintColor: VColor.contentTertiary
                ) {
                    onDismiss()
                }
            }
            .padding(EdgeInsets(top: VSpacing.lg, leading: VSpacing.lg, bottom: VSpacing.md, trailing: VSpacing.lg))

            VStack(alignment: .leading, spacing: VSpacing.xl) {
                contextHeader
                applyToSection
                treatAsSection
                saveSection
            }
            .padding(EdgeInsets(top: 0, leading: VSpacing.lg, bottom: VSpacing.lg, trailing: VSpacing.lg))
        }
        .frame(width: 480)
        .background(VColor.surfaceLift)
        .onAppear {
            selectedRiskLevel = riskLevel.isEmpty ? "medium" : riskLevel
            // If single option, use index 0. Otherwise, start at index 1 (skip exact match)
            if isSingleOption {
                selectedPatternIndex = 0
            }
        }
    }

    // MARK: - Context Header

    @ViewBuilder
    private var contextHeader: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            // Command text in code-style block
            Text(commandText)
                .font(VFont.bodySmallDefault.monospaced())
                .foregroundStyle(VColor.contentDefault)
                .lineLimit(2)
                .truncationMode(.tail)
                .padding(VSpacing.sm)
                .background(VColor.surfaceBase)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))

            // Description text
            if !commandDescription.isEmpty {
                Text(commandDescription)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
        }
    }

    // MARK: - Section 1: Apply to

    @ViewBuilder
    private var applyToSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Apply to")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)
                .accessibilityAddTraits(.isHeader)

            if generalizedOptions.count == 1 {
                // Single option: show as simple label, no radio buttons
                HStack {
                    Text(generalizedOptions[0].label)
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentDefault)
                        .padding(EdgeInsets(top: VSpacing.sm, leading: VSpacing.sm, bottom: VSpacing.sm, trailing: VSpacing.sm))
                        .background(VColor.surfaceBase)
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                    Spacer(minLength: 0)
                }
            } else if !generalizedOptions.isEmpty {
                // Multiple options: show radio list
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    ForEach(Array(generalizedOptions.enumerated()), id: \.element.id) { index, option in
                        patternRow(option: option, index: index)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func patternRow(option: V3ScopeOptionItem, index: Int) -> some View {
        // If single option, map directly to index 0. Otherwise, offset by 1 since we skip index 0.
        let targetIndex = isSingleOption ? index : index + 1
        Button {
            selectedPatternIndex = targetIndex
        } label: {
            HStack(spacing: VSpacing.sm) {
                VIconView(selectedPatternIndex == targetIndex ? .circleDot : .circle, size: 14)
                    .foregroundStyle(selectedPatternIndex == targetIndex ? VColor.primaryBase : VColor.contentTertiary)
                    .accessibilityHidden(true)

                Text(option.label)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)

                Spacer(minLength: 0)
            }
            .padding(EdgeInsets(top: VSpacing.sm, leading: VSpacing.sm, bottom: VSpacing.sm, trailing: VSpacing.sm))
            .contentShape(RoundedRectangle(cornerRadius: VRadius.sm))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(option.label)
        .accessibilityAddTraits(selectedPatternIndex == targetIndex ? [.isSelected] : [])
        .accessibilityValue(selectedPatternIndex == targetIndex ? "Selected" : "Not selected")
    }

    // MARK: - Section 2: Treat as

    @ViewBuilder
    private var treatAsSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Treat as")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)
                .accessibilityAddTraits(.isHeader)

            HStack(spacing: VSpacing.sm) {
                riskLevelButton(label: "Low", value: "low", color: VColor.systemPositiveStrong)
                riskLevelButton(label: "Medium", value: "medium", color: VColor.systemMidStrong)
                riskLevelButton(label: "High", value: "high", color: VColor.systemNegativeStrong)
            }

            if !riskLevelHint.isEmpty {
                Text(riskLevelHint)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
        }
    }

    @ViewBuilder
    private func riskLevelButton(label: String, value: String, color: Color) -> some View {
        Button {
            selectedRiskLevel = value
        } label: {
            HStack(spacing: VSpacing.xs) {
                Circle()
                    .fill(color)
                    .frame(width: 8, height: 8)
                Text(label)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)
            }
            .padding(EdgeInsets(top: VSpacing.xs, leading: VSpacing.sm, bottom: VSpacing.xs, trailing: VSpacing.sm))
            .background(
                selectedRiskLevel == value
                    ? VColor.surfaceActive
                    : Color.clear
            )
            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.sm)
                    .strokeBorder(
                        selectedRiskLevel == value ? color : VColor.borderBase,
                        lineWidth: selectedRiskLevel == value ? 1.5 : 0.5
                    )
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(selectedRiskLevel == value ? [.isSelected] : [])
        .accessibilityValue(selectedRiskLevel == value ? "Selected" : "Not selected")
    }

    // MARK: - Save Button

    @ViewBuilder
    private var saveSection: some View {
        HStack {
            Spacer(minLength: 0)
            VButton(
                label: "Save Rule",
                style: .primary,
                isDisabled: isSaving || scopeOptions.isEmpty || selectedPatternIndex >= scopeOptions.count
            ) {
                guard !isSaving, !scopeOptions.isEmpty, selectedPatternIndex < scopeOptions.count else { return }
                isSaving = true
                let selectedOption = scopeOptions[selectedPatternIndex]
                // Always use "everywhere" scope (directory scoping removed in v1)
                let rule = V3SavedRule(
                    toolName: toolName,
                    pattern: selectedOption.pattern,
                    riskLevel: selectedRiskLevel,
                    scope: "everywhere"
                )
                onSave(rule)
                onDismiss()
            }
        }
    }
}
