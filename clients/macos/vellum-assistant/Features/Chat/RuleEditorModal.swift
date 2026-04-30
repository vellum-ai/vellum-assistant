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

/// V3 Rule Editor Modal — minimal, focused on generalization and risk assessment.
/// Shows only the generalized pattern options (skips exact match) and risk level picker.
struct RuleEditorModal: View {
    /// Raw tool identifier (e.g. "bash", "host_bash") used for trust rule persistence.
    let toolName: String
    let commandText: String
    let commandDescription: String
    let riskLevel: String
    let scopeOptions: [ScopeOptionItem]
    let directoryScopeOptions: [ConfirmationRequestDirectoryScopeOption]
    /// Optional LLM-generated suggestion used to pre-populate selections.
    let suggestion: TrustRuleSuggestion?
    /// Existing trust rule that matched this tool call. Non-nil means edit mode.
    var existingRule: TrustRule? = nil
    let onSave: (SavedRule) -> Void
    /// Called in edit mode when the user wants to save a narrower pattern as a new rule.
    var onSaveAsNew: ((SavedRule) -> Void)? = nil
    let onDismiss: () -> Void

    @State private var selectedPatternIndex: Int = 1 // Start from first generalization (skip exact match at index 0)
    @State private var selectedRiskLevel: String = "medium"
    @State private var isSaving: Bool = false
    @State private var selectedDirectoryScopeIndex: Int = -1  // -1 = "Everywhere" (default)
    /// Set to true once the user manually changes the risk picker or pattern selection.
    /// Prevents a late-arriving LLM suggestion from silently overwriting their choice.
    @State private var hasUserInteracted: Bool = false

    /// Generalized pattern options.
    /// If scopeOptions has multiple elements, skip the exact match at index 0.
    /// If scopeOptions has only 1 element (single wildcard), show it directly.
    private var generalizedOptions: [ScopeOptionItem] {
        scopeOptions.count > 1 ? Array(scopeOptions.dropFirst()) : scopeOptions
    }

    /// Whether we're showing a single wildcard option (not skipping index 0)
    private var isSingleOption: Bool {
        scopeOptions.count == 1
    }

    /// Whether the options look like a pipeline decomposition (all "program *" patterns).
    /// Pipeline commands produce per-program wildcards that aren't useful as individual radio choices.
    private var isPipelineDecomposition: Bool {
        generalizedOptions.count > 3 && generalizedOptions.allSatisfy { option in
            let parts = option.label.split(separator: " ")
            return parts.count == 2 && parts.last == "*"
        }
    }

    /// Contextual hint for the selected risk level
    private var riskLevelHint: String {
        switch selectedRiskLevel.lowercased() {
        case "low":
            return "Auto-approved at Conservative tolerance or higher"
        case "medium":
            return "Auto-approved at Relaxed tolerance or higher"
        case "high":
            return "Auto-approved only at Full Access tolerance"
        default:
            return ""
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            HStack {
                Text(existingRule != nil ? "Edit Trust Rule" : "Create Trust Rule")
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
                whereSection
                treatAsSection
                saveSection
            }
            .padding(EdgeInsets(top: 0, leading: VSpacing.lg, bottom: VSpacing.lg, trailing: VSpacing.lg))
        }
        .frame(width: 480)
        .background(VColor.surfaceLift)
        .onAppear {
            applySuggestionOrDefaults()
        }
        .onChange(of: suggestion?.pattern) { _, _ in
            // Re-apply when LLM suggestion arrives after modal opened in loading state
            applySuggestionOrDefaults()
        }
    }

    // MARK: - Suggestion / Default Application

    /// Whether the Save As New button should be visible.
    private var showSaveAsNew: Bool {
        guard onSaveAsNew != nil, existingRule != nil else { return false }
        // Hide while suggestion is loading — avoids flickering when the suggestion
        // arrives and turns out to match the existing rule pattern.
        guard let suggestion else { return false }
        // Suppress if LLM found nothing narrower than the existing rule's pattern
        if let existing = existingRule, suggestion.pattern == existing.pattern {
            return false
        }
        return !generalizedOptions.isEmpty
    }

    private func applySuggestionOrDefaults() {
        if let existingRule {
            // Edit mode: pre-fill risk from existing rule, not from LLM suggestion.
            // Skip if user has already made a choice — a late-arriving suggestion
            // should not silently overwrite their selection.
            if !hasUserInteracted {
                selectedRiskLevel = existingRule.risk.isEmpty ? "medium" : existingRule.risk
            }
            if !hasUserInteracted {
                // In single-option mode the only Save As New choice is index 0; reset
                // the initial default of 1 so the option isn't permanently out-of-bounds.
                if isSingleOption { selectedPatternIndex = 0 }
            }
            if let suggestion, !hasUserInteracted {
                // Pre-select Save As New pattern: use LLM suggestion if it differs from existing rule
                if !suggestion.pattern.isEmpty,
                   suggestion.pattern != existingRule.pattern,
                   let matchIndex = scopeOptions.firstIndex(where: { $0.pattern == suggestion.pattern }),
                   matchIndex > 0 || isSingleOption {
                    selectedPatternIndex = matchIndex
                }
                // Directory scope: match suggestion scope to options
                if let suggestedScope = suggestion.scope, suggestedScope != "everywhere" {
                    let filtered = directoryScopeOptions.filter { $0.scope != "everywhere" }
                    if let matchIndex = filtered.firstIndex(where: { $0.scope == suggestedScope }) {
                        selectedDirectoryScopeIndex = matchIndex
                    }
                }
            }
        } else if let suggestion {
            // Create mode with suggestion
            if !hasUserInteracted {
                selectedRiskLevel = suggestion.risk.isEmpty ? (riskLevel.isEmpty ? "medium" : riskLevel) : suggestion.risk

                // Pattern: find the matching scope option index.
                // In multi-option mode the UI hides index 0 (exact match), so skip
                // it to avoid an invisible selection that silently persists.
                if let matchIndex = scopeOptions.firstIndex(where: { $0.pattern == suggestion.pattern }),
                   (matchIndex > 0 || isSingleOption) {
                    selectedPatternIndex = matchIndex
                } else if isSingleOption {
                    selectedPatternIndex = 0
                }

                // Directory scope: match suggestion scope to options
                if let suggestedScope = suggestion.scope, suggestedScope != "everywhere" {
                    let filtered = directoryScopeOptions.filter { $0.scope != "everywhere" }
                    if let matchIndex = filtered.firstIndex(where: { $0.scope == suggestedScope }) {
                        selectedDirectoryScopeIndex = matchIndex
                    }
                }
            }
        } else {
            // Create mode without suggestion
            if !hasUserInteracted {
                selectedRiskLevel = riskLevel.isEmpty ? "medium" : riskLevel
            }
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

            if let existingRule {
                // Edit mode: show existing rule pattern as read-only
                HStack(spacing: VSpacing.xs) {
                    Image(systemName: "lock.fill")
                        .font(.system(size: 10))
                        .foregroundStyle(VColor.contentTertiary)
                    Text(existingRule.pattern)
                        .font(VFont.bodyMediumDefault.monospaced())
                        .foregroundStyle(VColor.contentSecondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 0)
                }
                .padding(EdgeInsets(top: VSpacing.sm, leading: VSpacing.sm, bottom: VSpacing.sm, trailing: VSpacing.sm))
                .background(VColor.surfaceBase)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.sm)
                        .stroke(VColor.borderBase, lineWidth: 0.5)
                )

                // Narrower scope options for Save As New
                if showSaveAsNew, !generalizedOptions.isEmpty {
                    Text("Or narrow the scope:")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentSecondary)
                        .accessibilityAddTraits(.isHeader)

                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        ForEach(Array(generalizedOptions.enumerated()), id: \.element.id) { index, option in
                            patternRow(option: option, index: index)
                        }
                    }
                }
            } else if isPipelineDecomposition {
                // Pipeline decomposition: show first option as static label
                HStack {
                    Text(generalizedOptions[0].label)
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentDefault)
                        .padding(EdgeInsets(top: VSpacing.sm, leading: VSpacing.sm, bottom: VSpacing.sm, trailing: VSpacing.sm))
                        .background(VColor.surfaceBase)
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                    Spacer(minLength: 0)
                }
            } else if generalizedOptions.count == 1 {
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
    private func patternRow(option: ScopeOptionItem, index: Int) -> some View {
        // If single option, map directly to index 0. Otherwise, offset by 1 since we skip index 0.
        let targetIndex = isSingleOption ? index : index + 1
        Button {
            selectedPatternIndex = targetIndex
            hasUserInteracted = true
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

    // MARK: - Where Section

    @ViewBuilder
    private var whereSection: some View {
        if !directoryScopeOptions.isEmpty {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                Text("Where")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentSecondary)
                    .accessibilityAddTraits(.isHeader)

                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    ForEach(Array(directoryScopeOptions.filter { $0.scope != "everywhere" }.enumerated()), id: \.offset) { index, option in
                        directoryScopeRow(label: option.label, index: index)
                    }
                    directoryScopeRow(label: "Everywhere", index: -1)
                }
            }
        }
    }

    @ViewBuilder
    private func directoryScopeRow(label: String, index: Int) -> some View {
        Button {
            selectedDirectoryScopeIndex = index
            hasUserInteracted = true
        } label: {
            HStack(spacing: VSpacing.sm) {
                VIconView(selectedDirectoryScopeIndex == index ? .circleDot : .circle, size: 14)
                    .foregroundStyle(selectedDirectoryScopeIndex == index ? VColor.primaryBase : VColor.contentTertiary)
                    .accessibilityHidden(true)
                Text(label)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)
                Spacer(minLength: 0)
            }
            .padding(EdgeInsets(top: VSpacing.sm, leading: VSpacing.sm, bottom: VSpacing.sm, trailing: VSpacing.sm))
            .contentShape(RoundedRectangle(cornerRadius: VRadius.sm))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(selectedDirectoryScopeIndex == index ? [.isSelected] : [])
        .accessibilityValue(selectedDirectoryScopeIndex == index ? "Selected" : "Not selected")
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

            // In edit mode, show LLM suggestion as annotation when it differs from current selection
            if let existingRule,
               let suggestion,
               !suggestion.risk.isEmpty,
               suggestion.risk.lowercased() != existingRule.risk.lowercased() {
                HStack(spacing: VSpacing.xxs) {
                    Text("Suggested:")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                    Text(suggestion.risk.prefix(1).uppercased() + suggestion.risk.dropFirst())
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }
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
            hasUserInteracted = true
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

    private func resolvedScope() -> String {
        let filtered = directoryScopeOptions.filter { $0.scope != "everywhere" }
        if selectedDirectoryScopeIndex >= 0, selectedDirectoryScopeIndex < filtered.count {
            return filtered[selectedDirectoryScopeIndex].scope
        }
        return "everywhere"
    }

    @ViewBuilder
    private var saveSection: some View {
        HStack {
            if let existingRule {
                // Edit mode: Save (updates existing rule) + optional Save As New
                if showSaveAsNew, let onSaveAsNew {
                    VButton(
                        label: "Save As New",
                        style: .outlined,
                        isDisabled: isSaving || selectedPatternIndex >= scopeOptions.count
                    ) {
                        guard !isSaving, selectedPatternIndex < scopeOptions.count else { return }
                        isSaving = true
                        let selectedOption = scopeOptions[selectedPatternIndex]
                        onSaveAsNew(SavedRule(
                            toolName: toolName,
                            pattern: selectedOption.pattern,
                            riskLevel: selectedRiskLevel,
                            scope: resolvedScope()
                        ))
                        onDismiss()
                    }
                }
                Spacer(minLength: 0)
                VButton(
                    label: "Save",
                    style: .primary,
                    isDisabled: isSaving
                ) {
                    guard !isSaving else { return }
                    isSaving = true
                    onSave(SavedRule(
                        toolName: toolName,
                        pattern: existingRule.pattern,
                        riskLevel: selectedRiskLevel,
                        scope: "everywhere"
                    ))
                    onDismiss()
                }
            } else {
                // Create mode
                Spacer(minLength: 0)
                VButton(
                    label: "Save Rule",
                    style: .primary,
                    isDisabled: isSaving || scopeOptions.isEmpty || selectedPatternIndex >= scopeOptions.count
                ) {
                    guard !isSaving, !scopeOptions.isEmpty, selectedPatternIndex < scopeOptions.count else { return }
                    isSaving = true
                    let selectedOption = scopeOptions[selectedPatternIndex]
                    onSave(SavedRule(
                        toolName: toolName,
                        pattern: selectedOption.pattern,
                        riskLevel: selectedRiskLevel,
                        scope: resolvedScope()
                    ))
                    onDismiss()
                }
            }
        }
    }
}
