import SwiftUI

// MARK: - Helper Types

struct ScopeOptionItem: Identifiable, Equatable {
    let id = UUID()
    let label: String
    let description: String
    let pattern: String
}

struct SavedRule {
    let toolName: String
    let pattern: String
    let riskLevel: String
    let scope: String
}

// MARK: - RuleEditorModal

/// Modal for creating trust rules from the scope ladder.
/// Presents five sections: context (read-only), pattern ladder (radio buttons),
/// risk level picker (segmented control), scope toggle, and a save button.
struct RuleEditorModal: View {
    let toolName: String
    let command: String
    let currentRiskLevel: String
    let riskReason: String
    let scopeOptions: [ScopeOptionItem]
    let workingDir: String
    let onSave: (SavedRule) -> Void
    let onDismiss: () -> Void

    @State private var selectedPatternIndex: Int = 0
    @State private var selectedRiskLevel: String = "medium"
    @State private var selectedScope: String = "everywhere"
    @State private var isSaving: Bool = false

    /// Shortens the working directory path by replacing the home directory prefix with ~.
    private var displayPath: String {
        (workingDir as NSString).abbreviatingWithTildeInPath
    }

    /// Maps a risk level string to a semantic color.
    private func riskColor(for level: String) -> Color {
        switch level.lowercased() {
        case "high":
            return VColor.systemNegativeStrong
        case "medium":
            return VColor.systemMidStrong
        case "low":
            return VColor.systemPositiveStrong
        default:
            return VColor.contentSecondary
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

            ScrollView {
                VStack(alignment: .leading, spacing: VSpacing.xl) {
                    contextSection
                    patternLadderSection
                    riskLevelSection
                    scopeSection
                    saveSection
                }
                .padding(EdgeInsets(top: 0, leading: VSpacing.lg, bottom: VSpacing.lg, trailing: VSpacing.lg))
            }
        }
        .frame(width: 480)
        .background(VColor.surfaceLift)
        .onAppear {
            selectedRiskLevel = currentRiskLevel
        }
    }

    // MARK: - Section 1: Context (read-only)

    @ViewBuilder
    private var contextSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Context")
                .font(VFont.bodyMediumEmphasised)
                .foregroundStyle(VColor.contentDefault)
                .accessibilityAddTraits(.isHeader)

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                HStack(spacing: VSpacing.xs) {
                    Text("Tool:")
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentSecondary)
                    Text(toolName)
                        .font(VFont.bodySmallEmphasised)
                        .foregroundStyle(VColor.contentDefault)
                }

                Text(command)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(VColor.contentDefault)
                    .padding(EdgeInsets(top: VSpacing.xs, leading: VSpacing.sm, bottom: VSpacing.xs, trailing: VSpacing.sm))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(VColor.surfaceBase)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))

                HStack(spacing: VSpacing.xs) {
                    Text("Risk:")
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentSecondary)
                    Text(currentRiskLevel.capitalized)
                        .font(VFont.bodySmallEmphasised)
                        .foregroundStyle(riskColor(for: currentRiskLevel))
                }

                if !riskReason.isEmpty {
                    Text(riskReason)
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }
            }
        }
    }

    // MARK: - Section 2: Pattern Ladder

    @ViewBuilder
    private var patternLadderSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Pattern")
                .font(VFont.bodyMediumEmphasised)
                .foregroundStyle(VColor.contentDefault)
                .accessibilityAddTraits(.isHeader)

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                ForEach(Array(scopeOptions.enumerated()), id: \.element.id) { index, option in
                    patternRow(option: option, index: index)
                }
            }
        }
    }

    @ViewBuilder
    private func patternRow(option: ScopeOptionItem, index: Int) -> some View {
        Button {
            selectedPatternIndex = index
        } label: {
            HStack(alignment: .top, spacing: VSpacing.sm) {
                Image(systemName: selectedPatternIndex == index ? "circle.inset.filled" : "circle")
                    .foregroundStyle(selectedPatternIndex == index ? VColor.primaryBase : VColor.contentTertiary)
                    .font(.system(size: 14))
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(VColor.contentDefault)
                    Text(option.description)
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentSecondary)
                }
            }
            .padding(EdgeInsets(top: VSpacing.sm, leading: VSpacing.sm, bottom: VSpacing.sm, trailing: VSpacing.sm))
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                selectedPatternIndex == index
                    ? VColor.surfaceActive
                    : Color.clear
            )
            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
            .contentShape(RoundedRectangle(cornerRadius: VRadius.sm))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(option.label): \(option.description)")
        .accessibilityAddTraits(selectedPatternIndex == index ? [.isSelected] : [])
        .accessibilityValue(selectedPatternIndex == index ? "Selected" : "Not selected")
    }

    // MARK: - Section 3: Risk Level Picker

    @ViewBuilder
    private var riskLevelSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Risk Level")
                .font(VFont.bodyMediumEmphasised)
                .foregroundStyle(VColor.contentDefault)
                .accessibilityAddTraits(.isHeader)

            Picker("Risk Level", selection: $selectedRiskLevel) {
                Text("Low").tag("low")
                Text("Medium").tag("medium")
                Text("High").tag("high")
            }
            .pickerStyle(.segmented)
            .labelsHidden()
        }
    }

    // MARK: - Section 4: Scope

    @ViewBuilder
    private var scopeSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Scope")
                .font(VFont.bodyMediumEmphasised)
                .foregroundStyle(VColor.contentDefault)
                .accessibilityAddTraits(.isHeader)

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                scopeRadioButton(
                    label: "Everywhere",
                    value: "everywhere"
                )
                scopeRadioButton(
                    label: "In \(displayPath)",
                    value: "project"
                )
            }
        }
    }

    @ViewBuilder
    private func scopeRadioButton(label: String, value: String) -> some View {
        Button {
            selectedScope = value
        } label: {
            HStack(spacing: VSpacing.sm) {
                Image(systemName: selectedScope == value ? "circle.inset.filled" : "circle")
                    .foregroundStyle(selectedScope == value ? VColor.primaryBase : VColor.contentTertiary)
                    .font(.system(size: 14))
                    .accessibilityHidden(true)
                Text(label)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)
            }
            .padding(EdgeInsets(top: VSpacing.xs, leading: VSpacing.sm, bottom: VSpacing.xs, trailing: VSpacing.sm))
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                selectedScope == value
                    ? VColor.surfaceActive
                    : Color.clear
            )
            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
            .contentShape(RoundedRectangle(cornerRadius: VRadius.sm))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(selectedScope == value ? [.isSelected] : [])
        .accessibilityValue(selectedScope == value ? "Selected" : "Not selected")
    }

    // MARK: - Section 5: Save

    @ViewBuilder
    private var saveSection: some View {
        HStack {
            Spacer(minLength: 0)
            VButton(
                label: "Save Rule",
                style: .primary,
                isDisabled: isSaving || scopeOptions.isEmpty
            ) {
                guard !isSaving, !scopeOptions.isEmpty else { return }
                isSaving = true
                let selectedOption = scopeOptions[selectedPatternIndex]
                let rule = SavedRule(
                    toolName: toolName,
                    pattern: selectedOption.pattern,
                    riskLevel: selectedRiskLevel,
                    scope: selectedScope
                )
                onSave(rule)
                onDismiss()
            }
        }
    }
}
