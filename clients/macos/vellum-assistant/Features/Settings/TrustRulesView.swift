import SwiftUI
import VellumAssistantShared

// MARK: - V3 Trust Rules View

struct TrustRulesView: View {
    let trustRuleClient: TrustRuleClientProtocol
    @Environment(\.dismiss) private var dismiss

    @State private var rules: [TrustRule] = []
    @State private var isLoading = true
    @State private var showAllDefaults = false
    @State private var editingRule: TrustRule? = nil
    @State private var ruleToDelete: TrustRule? = nil

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("Trust Rules")
                    .font(VFont.titleSmall)
                    .foregroundStyle(VColor.contentDefault)
                Spacer()
                VToggle(isOn: $showAllDefaults, label: "Show all defaults")
                VButton(label: "Done", style: .outlined) {
                    dismiss()
                }
                .keyboardShortcut(.cancelAction)
            }
            .padding()

            SettingsDivider()

            // Content
            if isLoading {
                Spacer()
                ProgressView()
                Spacer()
            } else if rules.isEmpty {
                Spacer()
                VStack(spacing: VSpacing.sm) {
                    VIconView(.shieldCheck, size: 32)
                        .foregroundStyle(VColor.contentTertiary)
                    Text("No trust rules yet. Rules are created when you classify actions from permission prompts.")
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentTertiary)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 320)
                }
                Spacer()
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(rules) { rule in
                            V3TrustRuleRow(
                                rule: rule,
                                onEdit: { editingRule = rule },
                                onDelete: { ruleToDelete = rule }
                            )
                        }
                    }
                }
            }
        }
        .frame(width: 600)
        .frame(minHeight: 500)
        .task(id: showAllDefaults) { await loadRules() }
        .sheet(item: $editingRule) { rule in
            V3TrustRuleEditSheet(
                rule: rule,
                trustRuleClient: trustRuleClient,
                onSave: { await loadRules() }
            )
        }
        .alert("Delete Trust Rule?", isPresented: Binding(
            get: { ruleToDelete != nil },
            set: { if !$0 { ruleToDelete = nil } }
        )) {
            Button("Cancel", role: .cancel) { ruleToDelete = nil }
            Button("Delete", role: .destructive) {
                if let rule = ruleToDelete {
                    Task { await deleteRule(rule: rule) }
                    ruleToDelete = nil
                }
            }
        } message: {
            if let rule = ruleToDelete {
                Text("Remove the trust rule for \(rule.tool) matching \"\(rule.pattern)\"?")
            }
        }
    }

    // MARK: - Data Loading

    @MainActor
    private func loadRules() async {
        isLoading = true
        do {
            if showAllDefaults {
                // Fetch all default rules plus user-relevant rules, merge and deduplicate
                async let defaultRules = trustRuleClient.listRules(origin: "default", tool: nil, includeDeleted: nil)
                async let userRules = trustRuleClient.listRules(origin: nil, tool: nil, includeDeleted: nil)
                let allDefaults = try await defaultRules
                let allUser = try await userRules
                var seen = Set<String>()
                var merged: [TrustRule] = []
                for rule in allUser {
                    if seen.insert(rule.id).inserted {
                        merged.append(rule)
                    }
                }
                for rule in allDefaults {
                    if seen.insert(rule.id).inserted {
                        merged.append(rule)
                    }
                }
                rules = merged.sorted { lhs, rhs in
                    if lhs.tool != rhs.tool { return lhs.tool < rhs.tool }
                    return lhs.description < rhs.description
                }
            } else {
                let fetched = try await trustRuleClient.listRules(origin: nil, tool: nil, includeDeleted: nil)
                rules = fetched.sorted { lhs, rhs in
                    if lhs.tool != rhs.tool { return lhs.tool < rhs.tool }
                    return lhs.description < rhs.description
                }
            }
        } catch {
            // Fetch failed — keep previous rules visible
        }
        isLoading = false
    }

    // MARK: - Delete

    @MainActor
    private func deleteRule(rule: TrustRule) async {
        do {
            try await trustRuleClient.deleteRule(id: rule.id)
            withAnimation {
                rules.removeAll { $0.id == rule.id }
            }
        } catch {
            // Delete failed — keep the rule visible
        }
    }
}

// MARK: - V3 Trust Rule Row

private struct V3TrustRuleRow: View {
    let rule: TrustRule
    let onEdit: () -> Void
    let onDelete: () -> Void

    private func riskColor(_ risk: String) -> Color {
        switch risk.lowercased() {
        case "low": return VColor.systemPositiveStrong
        case "medium": return VColor.systemMidStrong
        case "high": return VColor.systemNegativeStrong
        default: return VColor.contentTertiary
        }
    }

    /// Allow deleting user-defined rules and modified defaults; hide delete for unmodified defaults.
    private var canDelete: Bool {
        !(rule.origin == "default" && !rule.userModified)
    }

    var body: some View {
        HStack(spacing: VSpacing.md) {
            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text(rule.description)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(2)
                Text(rule.tool)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }

            Spacer()

            // Risk badge
            Text(rule.risk.lowercased())
                .font(VFont.labelDefault)
                .padding(EdgeInsets(top: 2, leading: 8, bottom: 2, trailing: 8))
                .background(riskColor(rule.risk).opacity(0.15))
                .foregroundStyle(riskColor(rule.risk))
                .clipShape(Capsule())

            // Origin / modified indicators
            if rule.origin == "default" {
                Text("Default")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }

            if rule.userModified {
                Text("Modified")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.systemMidStrong)
            }

            // Edit button
            Button {
                onEdit()
            } label: {
                VIconView(.pencil, size: 14)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Edit \(rule.description) trust rule")

            // Delete button (only for user-defined or modified defaults)
            if canDelete {
                Button {
                    onDelete()
                } label: {
                    VIconView(.trash, size: 14)
                        .foregroundStyle(VColor.systemNegativeStrong)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Delete \(rule.description) trust rule")
            }
        }
        .padding(EdgeInsets(top: VSpacing.sm, leading: VSpacing.lg, bottom: VSpacing.sm, trailing: VSpacing.lg))
        .contentShape(Rectangle())
        .onTapGesture { onEdit() }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(rule.description)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { onEdit() }
    }
}

// MARK: - V3 Trust Rule Edit Sheet

private struct V3TrustRuleEditSheet: View {
    let rule: TrustRule
    let trustRuleClient: TrustRuleClientProtocol
    let onSave: @Sendable () async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var selectedRisk: String = ""
    @State private var isSaving = false
    @State private var saveError: String? = nil

    var body: some View {
        VStack(spacing: VSpacing.lg) {
            // Title
            Text("Edit Trust Rule")
                .font(VFont.titleSmall)
                .foregroundStyle(VColor.contentDefault)

            // Pattern
            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text("Pattern")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
                Text(rule.pattern)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)
                    .textSelection(.enabled)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            // Description
            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text("Description")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
                Text(rule.description)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            // Risk level picker
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                Text("Risk Level")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)

                HStack(spacing: VSpacing.sm) {
                    riskLevelButton(label: "Low", value: "low", color: VColor.systemPositiveStrong)
                    riskLevelButton(label: "Medium", value: "medium", color: VColor.systemMidStrong)
                    riskLevelButton(label: "High", value: "high", color: VColor.systemNegativeStrong)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            // Reset to Default button (only for modified defaults)
            if rule.origin == "default" && rule.userModified {
                VButton(label: "Reset to Default", style: .outlined) {
                    isSaving = true
                    saveError = nil
                    Task {
                        do {
                            _ = try await trustRuleClient.resetRule(id: rule.id)
                            await onSave()
                            dismiss()
                        } catch {
                            saveError = error.localizedDescription
                            isSaving = false
                        }
                    }
                }
            }

            // Error message
            if let saveError {
                Text(saveError)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.systemNegativeStrong)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            Spacer()

            // Buttons row
            HStack {
                Spacer()
                VButton(label: "Cancel", style: .ghost) {
                    dismiss()
                }
                VButton(
                    label: "Save",
                    style: .primary,
                    isDisabled: selectedRisk == rule.risk || isSaving
                ) {
                    isSaving = true
                    saveError = nil
                    Task {
                        do {
                            _ = try await trustRuleClient.updateRule(id: rule.id, risk: selectedRisk, description: nil)
                            await onSave()
                            dismiss()
                        } catch {
                            saveError = error.localizedDescription
                            isSaving = false
                        }
                    }
                }
            }
        }
        .padding(VSpacing.lg)
        .frame(width: 400)
        .onAppear {
            selectedRisk = rule.risk
        }
    }

    @ViewBuilder
    private func riskLevelButton(label: String, value: String, color: Color) -> some View {
        Button {
            selectedRisk = value
        } label: {
            HStack(spacing: VSpacing.xs) {
                Circle()
                    .fill(color)
                    .frame(width: 8, height: 8)
                Text(label)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(selectedRisk == value ? VColor.auxWhite : color)
            }
            .padding(EdgeInsets(top: VSpacing.xs, leading: VSpacing.sm, bottom: VSpacing.xs, trailing: VSpacing.sm))
            .background(
                selectedRisk == value
                    ? color
                    : Color.clear
            )
            .clipShape(Capsule())
            .overlay(
                Capsule()
                    .strokeBorder(color, lineWidth: selectedRisk == value ? 0 : 1)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(selectedRisk == value ? [.isSelected] : [])
        .accessibilityValue(selectedRisk == value ? "Selected" : "Not selected")
    }
}
