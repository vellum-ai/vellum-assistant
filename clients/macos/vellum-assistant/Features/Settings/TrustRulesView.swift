import SwiftUI
import VellumAssistantShared

// MARK: - Trust Rules View

struct TrustRulesView: View {
    let daemonClient: DaemonClient
    @Environment(\.dismiss) var dismiss

    @State private var rules: [TrustRuleItem] = []
    @State private var isLoading = true
    @State private var showingAddSheet = false
    @State private var editingRule: TrustRuleItem? = nil
    @State private var ruleToDelete: TrustRuleItem? = nil

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("Trust Rules")
                    .font(.headline)
                Spacer()
                Button {
                    showingAddSheet = true
                } label: {
                    Label { Text("Add Rule") } icon: { VIconView(.plus, size: 14) }
                }
                Button("Done") { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }
            .padding()

            Divider()

            if isLoading {
                Spacer()
                ProgressView()
                Spacer()
            } else if rules.isEmpty {
                Spacer()
                VStack(spacing: 8) {
                    VIconView(.shieldOff, size: 32)
                        .foregroundStyle(.secondary)
                    Text("No trust rules configured")
                        .foregroundStyle(.secondary)
                }
                Spacer()
            } else {
                List {
                    ForEach(rules) { rule in
                        TrustRuleRow(
                            rule: rule,
                            isDefault: isDefaultRule(rule),
                            onEdit: { editingRule = rule },
                            onDelete: { ruleToDelete = rule }
                        )
                    }
                }
            }
        }
        .frame(width: 600, height: 500)
        .onAppear {
            daemonClient.isTrustRulesSheetOpen = true
            daemonClient.onTrustRulesListResponse = { items in
                rules = items
                isLoading = false
            }
            loadRules()
        }
        .onDisappear {
            daemonClient.onTrustRulesListResponse = nil
            daemonClient.isTrustRulesSheetOpen = false
        }
        .sheet(isPresented: $showingAddSheet) {
            TrustRuleFormView(daemonClient: daemonClient) {
                loadRules()
            }
        }
        .sheet(item: $editingRule) { rule in
            TrustRuleFormView(daemonClient: daemonClient, existingRule: rule) {
                loadRules()
            }
        }
        .alert("Delete Trust Rule?", isPresented: Binding(
            get: { ruleToDelete != nil },
            set: { if !$0 { ruleToDelete = nil } }
        )) {
            Button("Cancel", role: .cancel) { ruleToDelete = nil }
            Button("Delete", role: .destructive) {
                if let rule = ruleToDelete {
                    deleteRule(id: rule.id)
                    ruleToDelete = nil
                }
            }
        } message: {
            if let rule = ruleToDelete {
                Text("Remove the \(rule.decision) rule for \(rule.tool) with pattern \"\(rule.pattern)\"?")
            }
        }
    }

    @MainActor private func loadRules() {
        isLoading = true
        try? daemonClient.sendListTrustRules()
    }

    @MainActor private func deleteRule(id: String) {
        do {
            try daemonClient.sendRemoveTrustRule(id: id)
            withAnimation {
                rules.removeAll { $0.id == id }
            }
        } catch {
            // Send failed — keep the rule visible
        }
    }

    private func isDefaultRule(_ rule: TrustRuleItem) -> Bool {
        rule.priority >= 1000 || rule.id.hasPrefix("default:")
    }
}

// MARK: - Trust Rule Row

private struct TrustRuleRow: View {
    let rule: TrustRuleItem
    let isDefault: Bool
    let onEdit: () -> Void
    let onDelete: () -> Void

    private func decisionColor(_ decision: String) -> Color {
        switch decision {
        case "allow": return VColor.success
        case "ask": return VColor.warning
        default: return VColor.error
        }
    }

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(rule.tool)
                        .fontWeight(.medium)
                    Text(rule.decision)
                        .font(.caption)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(decisionColor(rule.decision).opacity(0.15))
                        .foregroundStyle(decisionColor(rule.decision))
                        .clipShape(Capsule())
                }
                Text(rule.pattern)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                HStack(spacing: 6) {
                    Text(rule.scope == "" || rule.scope == "*" ? "everywhere" : rule.scope)
                    Text("priority \(rule.priority)")
                }
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
            .textSelection(.enabled)

            Spacer()

            if !isDefault {
                Button {
                    onEdit()
                } label: {
                    VIconView(.pencil, size: 14)
                }
                .buttonStyle(.borderless)

                Button {
                    onDelete()
                } label: {
                    VIconView(.trash, size: 14)
                        .foregroundStyle(.red)
                }
                .buttonStyle(.borderless)
            }
        }
        .padding(.vertical, 2)
        .opacity(isDefault ? 0.5 : 1.0)
    }
}

// MARK: - Trust Rule Form (Add / Edit)

private struct TrustRuleFormView: View {
    let daemonClient: DaemonClient
    let existingRule: TrustRuleItem?
    let onSave: () -> Void
    @Environment(\.dismiss) var dismiss

    @State private var tool: String
    @State private var pattern: String
    @State private var scope: String
    @State private var isEverywhere: Bool
    @State private var decision: String

    private let toolOptions = ["bash", "file_read", "file_write", "file_edit", "web_fetch", "skill_load"]

    init(daemonClient: DaemonClient, existingRule: TrustRuleItem? = nil, onSave: @escaping () -> Void) {
        self.daemonClient = daemonClient
        self.existingRule = existingRule
        self.onSave = onSave

        if let rule = existingRule {
            _tool = State(initialValue: rule.tool)
            _pattern = State(initialValue: rule.pattern)
            let everywhere = rule.scope == "" || rule.scope == "*"
            _scope = State(initialValue: everywhere ? "" : rule.scope)
            _isEverywhere = State(initialValue: everywhere)
            _decision = State(initialValue: rule.decision)
        } else {
            _tool = State(initialValue: "bash")
            _pattern = State(initialValue: "")
            _scope = State(initialValue: "")
            _isEverywhere = State(initialValue: true)
            _decision = State(initialValue: "allow")
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(existingRule != nil ? "Edit Trust Rule" : "Add Trust Rule")
                    .font(.headline)
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }
            .padding()

            Divider()

            Form {
                Picker("Tool", selection: $tool) {
                    ForEach(toolOptions, id: \.self) { option in
                        Text(option).tag(option)
                    }
                }

                TextField("Pattern", text: $pattern, prompt: Text("e.g., git *"))

                VToggle(isOn: $isEverywhere, label: "Everywhere")
                if !isEverywhere {
                    TextField("Scope", text: $scope, prompt: Text("e.g., /Users/me/project"))
                }

                Picker("Decision", selection: $decision) {
                    Text("Allow").tag("allow")
                    Text("Ask").tag("ask")
                    Text("Deny").tag("deny")
                }
            }
            .formStyle(.grouped)

            HStack {
                Spacer()
                Button("Save") {
                    save()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(pattern.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding()
        }
        .frame(width: 420, height: 340)
    }

    @MainActor private func save() {
        let trimmedPattern = pattern.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedPattern.isEmpty else { return }

        let resolvedScope = isEverywhere ? "*" : scope.trimmingCharacters(in: .whitespacesAndNewlines)

        if let existing = existingRule {
            try? daemonClient.sendUpdateTrustRule(
                id: existing.id,
                tool: tool,
                pattern: trimmedPattern,
                scope: resolvedScope,
                decision: decision
            )
        } else {
            try? daemonClient.sendAddTrustRule(
                toolName: tool,
                pattern: trimmedPattern,
                scope: resolvedScope,
                decision: decision
            )
        }

        onSave()
        dismiss()
    }
}
