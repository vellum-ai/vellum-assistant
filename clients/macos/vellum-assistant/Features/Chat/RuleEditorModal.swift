import SwiftUI
import VellumAssistantShared

// MARK: - Helper Types

struct ScopeOptionItem: Identifiable, Equatable {
    let id = UUID()
    let label: String
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
    /// Raw tool identifier (e.g. "bash", "host_bash") used for trust rule persistence.
    let toolName: String
    /// Human-friendly display name (e.g. "Run Command") shown in the context section.
    let displayName: String
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
            selectedRiskLevel = currentRiskLevel.isEmpty ? "medium" : currentRiskLevel
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
                    Text(displayName)
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
            HStack(spacing: VSpacing.sm) {
                Image(systemName: selectedPatternIndex == index ? "circle.inset.filled" : "circle")
                    .foregroundStyle(selectedPatternIndex == index ? VColor.primaryBase : VColor.contentTertiary)
                    .font(.system(size: 14))
                    .accessibilityHidden(true)

                Text(option.label)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(VColor.contentDefault)
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
        .accessibilityLabel(option.label)
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

            HStack(spacing: VSpacing.sm) {
                riskLevelButton(label: "Low", value: "low", color: VColor.systemPositiveStrong)
                riskLevelButton(label: "Medium", value: "medium", color: VColor.systemMidStrong)
                riskLevelButton(label: "High", value: "high", color: VColor.systemNegativeStrong)
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
    }

    // MARK: - Section 4: Scope

    /// Whether the working directory looks like a real user project (not an
    /// internal sandbox/container path). When false, the "In [project]" scope
    /// option is hidden — only "Everywhere" is offered.
    ///
    // TODO: The daemon could provide an isContainerized flag on tool call data
    // so the client doesn't need path heuristics to detect sandbox directories.
    private var isUserProjectDir: Bool {
        // Internal sandbox paths live under the XDG data directory structure:
        // ~/.local/share/vellum/assistants/ (production)
        // ~/.local/share/vellum-dev/assistants/ (development)
        // ~/.local/share/vellum-staging/assistants/ (staging)
        // ~/.local/share/vellum-test/assistants/ (test)
        // Anchoring on "/.local/share/vellum" avoids false-matching legit user
        // project paths like /Users/dev/code/vellum/assistants/my-bot/.
        let lower = workingDir.lowercased()
        if lower.contains("/.local/share/vellum/assistants/")
            || lower.contains("/.local/share/vellum-dev/assistants/")
            || lower.contains("/.local/share/vellum-staging/assistants/")
            || lower.contains("/.local/share/vellum-test/assistants/") {
            return false
        }
        return true
    }

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
                if isUserProjectDir {
                    scopeRadioButton(
                        label: "In \(displayPath)",
                        value: "project"
                    )
                }
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
                // Resolve "project" to the actual filesystem path for trust matching.
                let resolvedScope = selectedScope == "project" ? workingDir : selectedScope
                let rule = SavedRule(
                    toolName: toolName,
                    pattern: selectedOption.pattern,
                    riskLevel: selectedRiskLevel,
                    scope: resolvedScope
                )
                onSave(rule)
                onDismiss()
            }
        }
    }
}
