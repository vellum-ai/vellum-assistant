import SwiftUI
import VellumAssistantShared

/// Read-only sheet listing every call site that has at least one explicit
/// `provider`, `model`, or `profile` override set under `llm.callSites.<id>`
/// in the workspace config. Grouped by `CallSiteDomain` so the rendering
/// matches the picker UI introduced in PRs 23-24.
///
/// PR 22 ships the read-only view + a "N per-task overrides" badge in the
/// Inference card. PR 23 makes individual rows editable. PR 24 layers in
/// reset / preset actions on top.
@MainActor
struct CallSiteOverridesSheet: View {
    @ObservedObject var store: SettingsStore
    @Binding var isPresented: Bool

    /// Catalog entries that currently have at least one explicit override,
    /// keyed by domain in catalog order. Domains with no overridden call
    /// sites are omitted so the empty-state message renders cleanly when
    /// the user has nothing configured.
    private var overridesByDomain: [(domain: CallSiteDomain, entries: [CallSiteOverride])] {
        let active = store.callSiteOverrides.filter { $0.hasOverride }
        var grouped: [CallSiteDomain: [CallSiteOverride]] = [:]
        for entry in active {
            grouped[entry.domain, default: []].append(entry)
        }
        return CallSiteDomain.allCases
            .sorted { $0.sortOrder < $1.sortOrder }
            .compactMap { domain in
                guard let entries = grouped[domain], !entries.isEmpty else { return nil }
                return (domain: domain, entries: entries)
            }
    }

    var body: some View {
        VStack(spacing: 0) {
            // Header: title + subtitle + close button. Built with VStack
            // chrome rather than VModal so the inner List can manage its
            // own scrolling without nesting inside VModal's ScrollView.
            header
            SettingsDivider()

            if overridesByDomain.isEmpty {
                emptyState
            } else {
                overridesList
            }

            SettingsDivider()
            footer
        }
        .frame(width: 520, height: 480)
        .background(VColor.surfaceLift)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
    }

    // MARK: - Header / Footer

    private var header: some View {
        HStack(alignment: .top, spacing: VSpacing.md) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Per-Task Model Overrides")
                    .font(VFont.titleSmall)
                    .foregroundStyle(VColor.contentDefault)
                Text("Tasks listed here use a specific provider or model instead of your default.")
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            VButton(
                label: "Close",
                iconOnly: VIcon.x.rawValue,
                style: .ghost,
                tintColor: VColor.contentTertiary
            ) {
                isPresented = false
            }
        }
        .padding(VSpacing.lg)
    }

    private var footer: some View {
        HStack {
            Spacer()
            VButton(label: "Done", style: .outlined) {
                isPresented = false
            }
        }
        .padding(VSpacing.lg)
    }

    // MARK: - Empty State

    private var emptyState: some View {
        VStack(spacing: VSpacing.sm) {
            Spacer(minLength: 0)
            Text("No overrides set. All tasks use your default model.")
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, VSpacing.lg)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Overrides List

    private var overridesList: some View {
        List {
            ForEach(overridesByDomain, id: \.domain.id) { group in
                Section {
                    ForEach(group.entries) { entry in
                        overrideRow(entry)
                    }
                } header: {
                    Text(group.domain.displayName)
                }
            }
        }
        .listStyle(.inset)
        .frame(maxHeight: .infinity)
    }

    private func overrideRow(_ entry: CallSiteOverride) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xxs) {
            Text(entry.displayName)
                .font(VFont.bodyMediumDefault)
            Text(summary(for: entry))
                .font(VFont.bodySmallDefault)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, VSpacing.xxs)
    }

    /// Compose the secondary line for a given override entry.
    ///
    /// Format precedence:
    /// - `provider + model` → `"<Provider> · <model>"` (e.g. `"Anthropic · claude-haiku-4-5"`).
    /// - `model` only       → `"<model>"`.
    /// - `provider` only    → `"Provider: <Provider>"`.
    /// - `profile`          → `"Profile: <profile>"` (appended when paired with provider/model).
    private func summary(for entry: CallSiteOverride) -> String {
        var parts: [String] = []
        if let provider = entry.provider, let model = entry.model {
            parts.append("\(store.dynamicProviderDisplayName(provider)) \u{00B7} \(model)")
        } else if let model = entry.model {
            parts.append(model)
        } else if let provider = entry.provider {
            parts.append("Provider: \(store.dynamicProviderDisplayName(provider))")
        }
        if let profile = entry.profile {
            parts.append("Profile: \(profile)")
        }
        return parts.joined(separator: " \u{00B7} ")
    }
}
