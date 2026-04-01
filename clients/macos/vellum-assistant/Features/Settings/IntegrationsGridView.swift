import SwiftUI
import VellumAssistantShared

struct IntegrationsGridView: View {
    @ObservedObject var store: SettingsStore
    var authManager: AuthManager
    var showToast: (String, ToastInfo.Style) -> Void

    @State private var searchText = ""
    @State private var selectedProviderKey: String? = nil

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

    private var enabledProviders: [OAuthProviderMetadata] {
        filteredProviders.filter { provider in
            let connections = store.managedOAuthConnections[provider.provider_key] ?? []
            return !connections.isEmpty
        }
    }

    private var notEnabledProviders: [OAuthProviderMetadata] {
        filteredProviders.filter { provider in
            let connections = store.managedOAuthConnections[provider.provider_key] ?? []
            return connections.isEmpty
        }
    }

    // MARK: - Body

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            VSearchBar(placeholder: "Search integrations...", text: $searchText)

            Text("\(filteredProviders.count) integrations")
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentTertiary)

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
                    sectionView(title: "Enabled", count: enabledProviders.count, providers: enabledProviders)
                }

                if !notEnabledProviders.isEmpty {
                    sectionView(title: "Not Enabled", count: notEnabledProviders.count, providers: notEnabledProviders)
                }
            }
        }
        .onAppear {
            // Fetch connections for all providers so we can classify enabled vs not-enabled
            for provider in store.managedOAuthProviders {
                Task {
                    await store.fetchManagedOAuthConnections(providerKey: provider.provider_key)
                }
            }
        }
        .onChange(of: store.managedOAuthProviders.map(\.provider_key)) { _, _ in
            // Providers are fetched asynchronously, so re-trigger connection
            // fetching when they arrive (onAppear may fire while the list is
            // still empty).
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

    /// Computed binding that bridges the optional `selectedProviderKey` to a Bool
    /// for `.sheet(isPresented:)`, since `String` does not conform to `Identifiable`.
    private var isDetailPresented: Binding<Bool> {
        Binding(
            get: { selectedProviderKey != nil },
            set: { if !$0 { selectedProviderKey = nil } }
        )
    }

    // MARK: - Section

    private func sectionView(title: String, count: Int, providers: [OAuthProviderMetadata]) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack(spacing: VSpacing.xs) {
                Text(title)
                    .font(VFont.titleSmall)
                    .foregroundStyle(VColor.contentDefault)
                Text("\(count)")
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }

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
}
