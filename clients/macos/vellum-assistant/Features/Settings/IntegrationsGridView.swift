import SwiftUI
import VellumAssistantShared

struct IntegrationsGridView: View {
    @ObservedObject var store: SettingsStore
    var authManager: AuthManager
    var showToast: (String, ToastInfo.Style) -> Void

    @State private var searchText = ""
    @State private var selectedProviderKey: String? = nil
    @State private var isEnabledExpanded = true
    @State private var isNotEnabledExpanded = true

    private let columns = Array(
        repeating: GridItem(.flexible(), spacing: VSpacing.md),
        count: 3
    )

    // MARK: - Filtering

    private var filteredProviders: [OAuthProviderMetadata] {
        let providers = store.managedOAuthProviders
        guard !searchText.isEmpty else { return providers }
        return providers.filter { provider in
            let nameMatch = provider.display_name?.localizedCaseInsensitiveContains(searchText) ?? false
            let descMatch = provider.description?.localizedCaseInsensitiveContains(searchText) ?? false
            return nameMatch || descMatch
        }
    }

    private func hasActiveConnections(for providerKey: String) -> Bool {
        let managedConnections = store.managedOAuthConnections[providerKey] ?? []
        if !managedConnections.isEmpty { return true }
        let yourOwnApps = store.yourOwnApps(for: providerKey)
        for app in yourOwnApps {
            let appConns = store.yourOwnOAuthConnectionsByApp[app.id] ?? []
            if !appConns.isEmpty { return true }
        }
        return false
    }

    private var enabledProviders: [OAuthProviderMetadata] {
        filteredProviders.filter { hasActiveConnections(for: $0.provider_key) }
    }

    private var notEnabledProviders: [OAuthProviderMetadata] {
        filteredProviders.filter { !hasActiveConnections(for: $0.provider_key) }
    }

    // MARK: - Body

    var body: some View {
        SettingsCard(
            title: "Integrations",
            subtitle: "\(store.managedOAuthProviders.count) integrations available"
        ) {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                VSearchBar(placeholder: "Search integrations...", text: $searchText)

                if filteredProviders.isEmpty && !searchText.isEmpty {
                    VEmptyState(
                        title: "No integrations matched",
                        subtitle: "No integrations matched \"\(searchText)\"",
                        icon: VIcon.search.rawValue
                    )
                    .frame(maxWidth: .infinity)
                    .padding(.top, VSpacing.xxxl)
                } else {
                    if !enabledProviders.isEmpty {
                        VDisclosureSection(
                            title: "Enabled",
                            isExpanded: $isEnabledExpanded
                        ) {
                            providerGrid(providers: enabledProviders)
                        }
                    }

                    if !notEnabledProviders.isEmpty {
                        VDisclosureSection(
                            title: "Not Enabled",
                            isExpanded: $isNotEnabledExpanded
                        ) {
                            providerGrid(providers: notEnabledProviders)
                        }
                    }
                }
            }
        }
        .onAppear {
            for provider in store.managedOAuthProviders {
                Task {
                    await store.fetchManagedOAuthConnections(providerKey: provider.provider_key)
                }
            }
        }
        .onChange(of: store.managedOAuthProviders.map(\.provider_key)) { _, _ in
            for provider in store.managedOAuthProviders {
                Task {
                    await store.fetchManagedOAuthConnections(providerKey: provider.provider_key)
                }
            }
        }
        .sheet(isPresented: isDetailPresented) {
            if let key = selectedProviderKey {
                IntegrationDetailModal(
                    store: store,
                    authManager: authManager,
                    showToast: showToast,
                    providerKey: key,
                    onClose: { selectedProviderKey = nil }
                )
            }
        }
    }

    private var isDetailPresented: Binding<Bool> {
        Binding(
            get: { selectedProviderKey != nil },
            set: { if !$0 { selectedProviderKey = nil } }
        )
    }

    // MARK: - Grid

    private func providerGrid(providers: [OAuthProviderMetadata]) -> some View {
        LazyVGrid(columns: columns, spacing: VSpacing.md) {
            ForEach(providers, id: \.provider_key) { provider in
                IntegrationCard(
                    providerKey: provider.provider_key,
                    displayName: provider.display_name ?? provider.provider_key,
                    description: provider.description,
                    action: {
                        selectedProviderKey = provider.provider_key
                    }
                )
            }
        }
    }
}
