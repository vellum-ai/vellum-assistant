#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct TrustRulesSection: View {
    @EnvironmentObject var clientProvider: ClientProvider
    @State private var trustRules: [TrustRuleItem] = []
    @State private var showingAddRule = false
    @State private var editingRule: TrustRuleItem?

    var body: some View {
        Form {
            Section {
                if trustRules.isEmpty {
                    Text("No trust rules configured")
                        .foregroundStyle(.secondary)
                        .font(.caption)
                } else {
                    ForEach(trustRules, id: \.id) { rule in
                        trustRuleRow(rule)
                    }
                    .onDelete { indexSet in
                        let rulesToDelete = indexSet.map { trustRules[$0] }
                        for rule in rulesToDelete {
                            deleteRule(rule)
                        }
                    }
                }

                Button {
                    showingAddRule = true
                } label: {
                    Label { Text("Add Rule") } icon: { VIconView(.plus, size: 14) }
                }
            }
        }
        .navigationTitle("Trust Rules")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showingAddRule) {
            TrustRuleFormView(daemon: clientProvider.client as? DaemonClient) { _ in
                loadTrustRules()
            }
        }
        .sheet(item: $editingRule) { rule in
            TrustRuleFormView(daemon: clientProvider.client as? DaemonClient, existing: rule) { _ in
                loadTrustRules()
            }
        }
        .onAppear { loadTrustRules() }
        .onChange(of: clientProvider.isConnected) { _, connected in
            if connected { loadTrustRules() }
        }
        .onDisappear {
            if let daemon = clientProvider.client as? DaemonClient {
                daemon.onTrustRulesListResponse = nil
            }
        }
    }

    @ViewBuilder
    private func trustRuleRow(_ rule: TrustRuleItem) -> some View {
        let isDefault = rule.priority >= 1000 || rule.id.hasPrefix("default:")
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Text(rule.tool)
                        .font(.body)
                    decisionBadge(rule.decision)
                }
                Text(rule.pattern)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Text(rule.scope == "" || rule.scope == "*" ? "everywhere" : rule.scope)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            Spacer()
            if !isDefault {
                Button {
                    editingRule = rule
                } label: {
                    VIconView(.pencil, size: 16)
                        .foregroundColor(VColor.contentSecondary)
                }
            }
        }
        .opacity(isDefault ? 0.6 : 1.0)
    }

    @ViewBuilder
    private func decisionBadge(_ decision: String) -> some View {
        let (color, label): (Color, String) = {
            switch decision {
            case "allow": return (VColor.systemPositiveStrong, "Allow")
            case "deny": return (VColor.systemNegativeStrong, "Deny")
            default: return (VColor.systemNegativeHover, "Ask")
            }
        }()
        Text(label)
            .font(.caption2)
            .fontWeight(.medium)
            .foregroundColor(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.15))
            .clipShape(Capsule())
    }

    private func loadTrustRules() {
        guard let daemon = clientProvider.client as? DaemonClient else { return }
        daemon.onTrustRulesListResponse = { rules in
            trustRules = rules
        }
        try? daemon.send(TrustRulesListMessage())
    }

    private func deleteRule(_ rule: TrustRuleItem) {
        guard let daemon = clientProvider.client as? DaemonClient else { return }
        try? daemon.send(RemoveTrustRuleMessage(id: rule.id))
        loadTrustRules()
    }
}

// MARK: - Trust Rule Form

struct TrustRuleFormView: View {
    let daemon: DaemonClient?
    var existing: TrustRuleItem?
    let onSave: (Bool) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var tool: String = "bash"
    @State private var pattern: String = ""
    @State private var isEverywhere: Bool = true
    @State private var scope: String = ""
    @State private var decision: String = "allow"

    private let toolOptions = ["bash", "file_read", "file_write", "file_edit", "web_fetch", "skill_load"]

    var body: some View {
        NavigationStack {
            Form {
                Picker("Tool", selection: $tool) {
                    ForEach(toolOptions, id: \.self) { t in
                        Text(t).tag(t)
                    }
                }

                TextField("Pattern (e.g. git *)", text: $pattern)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)

                Toggle("Apply everywhere", isOn: $isEverywhere)

                if !isEverywhere {
                    TextField("Scope (directory path)", text: $scope)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                }

                Picker("Decision", selection: $decision) {
                    Text("Allow").tag("allow")
                    Text("Ask").tag("ask")
                    Text("Deny").tag("deny")
                }
                .pickerStyle(.segmented)
            }
            .navigationTitle(existing == nil ? "Add Rule" : "Edit Rule")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        saveRule()
                        dismiss()
                    }
                    .disabled(pattern.isEmpty)
                }
            }
            .onAppear {
                if let rule = existing {
                    tool = rule.tool
                    pattern = rule.pattern
                    decision = rule.decision
                    isEverywhere = rule.scope == "" || rule.scope == "*"
                    scope = isEverywhere ? "" : rule.scope
                }
            }
        }
    }

    private func saveRule() {
        let finalScope = isEverywhere ? "*" : scope
        if let rule = existing {
            try? daemon?.send(UpdateTrustRuleMessage(
                id: rule.id,
                tool: tool,
                pattern: pattern,
                scope: finalScope,
                decision: decision
            ))
        } else {
            try? daemon?.send(AddTrustRuleMessage(
                toolName: tool,
                pattern: pattern,
                scope: finalScope,
                decision: decision
            ))
        }
        onSave(true)
    }
}
#endif
