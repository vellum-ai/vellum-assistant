#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// iOS settings screen for configuring media embed behaviour in chat.
/// Mirrors the macOS SettingsAppearanceTab "Media Embeds" section,
/// persisting state via UserDefaults rather than the workspace config file.
struct MediaEmbedSettingsSection: View {
    @AppStorage(UserDefaultsKeys.mediaEmbedsEnabled) private var mediaEmbedsEnabled: Bool = true

    /// Domain allowlist stored as a newline-joined string so @AppStorage can handle it.
    @AppStorage(UserDefaultsKeys.mediaEmbedVideoAllowlistDomains)
    private var domainsRaw: String = MediaEmbedSettings.defaultDomains.joined(separator: "\n")

    @State private var newDomain: String = ""
    @State private var showingAddDomain: Bool = false

    private var domains: [String] {
        domainsRaw
            .components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    var body: some View {
        Form {
            Section {
                Toggle("Enable inline video embeds", isOn: $mediaEmbedsEnabled)
            } footer: {
                Text("Automatically embed videos from allowed domains inline in chat messages.")
            }

            if mediaEmbedsEnabled {
                domainAllowlistSection
            }
        }
        .navigationTitle("Media Embeds")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showingAddDomain) {
            AddDomainSheet { domain in
                addDomain(domain)
            }
        }
    }

    private var domainAllowlistSection: some View {
        Section {
            if domains.isEmpty {
                Text("No domains configured")
                    .foregroundStyle(.secondary)
                    .font(.caption)
            } else {
                ForEach(domains, id: \.self) { domain in
                    Text(domain)
                        .font(.body)
                }
                .onDelete { indexSet in
                    removeDomains(at: indexSet)
                }
            }

            Button {
                showingAddDomain = true
            } label: {
                Label { Text("Add Domain") } icon: { VIconView(.plus, size: 14) }
            }

            if domains != MediaEmbedSettings.defaultDomains {
                Button("Reset to Defaults", role: .destructive) {
                    resetToDefaults()
                }
            }
        } header: {
            Text("Video Domain Allowlist")
        } footer: {
            Text("Videos are only embedded if their domain appears in this list.")
        }
    }

    private func addDomain(_ raw: String) {
        let normalized = MediaEmbedSettings.normalizeDomains([raw])
        guard let domain = normalized.first, !domains.contains(domain) else { return }
        var updated = domains
        updated.append(domain)
        domainsRaw = updated.joined(separator: "\n")
    }

    private func removeDomains(at indexSet: IndexSet) {
        var updated = domains
        updated.remove(atOffsets: indexSet)
        domainsRaw = updated.joined(separator: "\n")
    }

    private func resetToDefaults() {
        domainsRaw = MediaEmbedSettings.defaultDomains.joined(separator: "\n")
    }
}

// MARK: - Add Domain Sheet

private struct AddDomainSheet: View {
    let onAdd: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var domain: String = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("e.g. example.com", text: $domain)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                } footer: {
                    Text("Enter a hostname such as youtube.com. URL schemes and paths are stripped automatically.")
                }
            }
            .navigationTitle("Add Domain")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        onAdd(domain)
                        dismiss()
                    }
                    .disabled(domain.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}
#endif
