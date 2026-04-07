import SwiftUI
import VellumAssistantShared

// MARK: - Integration Filter

enum IntegrationFilter: String, CaseIterable {
    case all = "All"
    case enabled = "Enabled"
    case notEnabled = "Not Enabled"
}

// MARK: - Integrations Panel Content

struct IntegrationsPanelContent: View {
    @ObservedObject var store: SettingsStore
    var authManager: AuthManager
    var showToast: (String, ToastInfo.Style) -> Void

    @State private var searchText: String = ""
    @State private var selectedProviderKey: String? = nil
    @State private var selectedFilter: IntegrationFilter = .all

    // MARK: - Filtering & Sorting

    private func hasActiveConnections(for providerKey: String) -> Bool {
        let managedConnections = store.managedOAuthConnections[providerKey] ?? []
        if !managedConnections.isEmpty { return true }
        let yourOwnApps = store.yourOwnApps(for: providerKey)
        if !yourOwnApps.isEmpty { return true }
        return false
    }

    private func connectedCount(for providerKey: String) -> Int {
        let managedCount = (store.managedOAuthConnections[providerKey] ?? []).count
        let yourOwnApps = store.yourOwnApps(for: providerKey)
        let yourOwnCount = yourOwnApps.reduce(0) { sum, app in
            sum + (store.yourOwnOAuthConnectionsByApp[app.id] ?? []).count
        }
        return managedCount + yourOwnCount
    }

    private var filteredProviders: [OAuthProviderMetadata] {
        var providers = store.managedOAuthProviders

        // Search filter
        if !searchText.isEmpty {
            providers = providers.filter { provider in
                let nameMatch = provider.display_name?.localizedCaseInsensitiveContains(searchText) ?? false
                let descMatch = provider.description?.localizedCaseInsensitiveContains(searchText) ?? false
                return nameMatch || descMatch
            }
        }

        // Dropdown filter
        switch selectedFilter {
        case .all:
            break
        case .enabled:
            providers = providers.filter { hasActiveConnections(for: $0.provider_key) }
        case .notEnabled:
            providers = providers.filter { !hasActiveConnections(for: $0.provider_key) }
        }

        // Sort: enabled first, then alphabetical by display name
        providers.sort { a, b in
            let aEnabled = hasActiveConnections(for: a.provider_key)
            let bEnabled = hasActiveConnections(for: b.provider_key)
            if aEnabled != bEnabled { return aEnabled }
            let aName = (a.display_name ?? a.provider_key).lowercased()
            let bName = (b.display_name ?? b.provider_key).lowercased()
            return aName < bName
        }

        return providers
    }

    // MARK: - Body

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            filterBar
            contentView
                .padding(.top, VSpacing.lg)
        }
        .onAppear {
            store.fetchManagedOAuthProviders()
            fetchAllConnections()
        }
        .onChange(of: store.managedOAuthProviders.map(\.provider_key)) { _, _ in
            fetchAllConnections()
        }
        .sheet(isPresented: Binding(
            get: { selectedProviderKey != nil },
            set: { if !$0 { selectedProviderKey = nil } }
        )) {
            if let providerKey = selectedProviderKey {
                IntegrationDetailModal(
                    store: store,
                    authManager: authManager,
                    showToast: showToast,
                    providerKey: providerKey,
                    onClose: {
                        selectedProviderKey = nil
                        fetchAllConnections()
                    }
                )
            }
        }
    }

    // MARK: - Filter Bar

    private var filterBar: some View {
        HStack(spacing: VSpacing.sm) {
            VSearchBar(placeholder: "Search Integrations", text: $searchText)
            VDropdown(
                options: IntegrationFilter.allCases.map { VDropdownOption(label: $0.rawValue, value: $0) },
                selection: $selectedFilter,
                maxWidth: 150
            )
        }
    }

    // MARK: - Content View

    @ViewBuilder
    private var contentView: some View {
        if store.managedOAuthProvidersLoading && store.managedOAuthProviders.isEmpty {
            VStack {
                Spacer()
                VLoadingIndicator()
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if filteredProviders.isEmpty {
            VStack {
                Spacer()
                VEmptyState(
                    title: emptyStateTitle,
                    subtitle: emptyStateSubtitle,
                    icon: VIcon.search.rawValue
                )
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollView {
                LazyVStack(spacing: VSpacing.sm) {
                    ForEach(filteredProviders, id: \.provider_key) { provider in
                        IntegrationItemRow(
                            provider: provider,
                            isConnected: hasActiveConnections(for: provider.provider_key),
                            onEnable: {
                                selectedProviderKey = provider.provider_key
                            },
                            onEdit: {
                                selectedProviderKey = provider.provider_key
                            },
                            onDisable: {
                                selectedProviderKey = provider.provider_key
                            }
                        )
                    }
                }
                .background { OverlayScrollerStyle() }
            }
            .scrollContentBackground(.hidden)
        }
    }

    // MARK: - Empty State

    private var emptyStateTitle: String {
        if !searchText.isEmpty {
            return "No integrations matched"
        }
        switch selectedFilter {
        case .all: return "No Integrations Available"
        case .enabled: return "No Enabled Integrations"
        case .notEnabled: return "All Integrations Are Enabled"
        }
    }

    private var emptyStateSubtitle: String {
        if !searchText.isEmpty {
            return "No integrations matched \"\(searchText)\""
        }
        switch selectedFilter {
        case .all: return "Check your connection and try again."
        case .enabled: return "Connect an integration to get started."
        case .notEnabled: return "All available integrations have been connected."
        }
    }

    // MARK: - Data Fetching

    private func fetchAllConnections() {
        Task {
            await store.fetchAllManagedOAuthConnections()
        }
        for provider in store.managedOAuthProviders {
            store.fetchYourOwnOAuthApps(providerKey: provider.provider_key)
        }
    }
}

// MARK: - Integration Item Row

private struct IntegrationItemRow: View {
    let provider: OAuthProviderMetadata
    let isConnected: Bool
    let onEnable: () -> Void
    let onEdit: () -> Void
    let onDisable: () -> Void

    @State private var isMenuOpen = false
    @State private var activePanel: VMenuPanel?
    @State private var triggerFrame: CGRect = .zero

    var body: some View {
        VCard {
            HStack(alignment: .center, spacing: VSpacing.lg) {
                IntegrationIcon.image(
                    for: provider.provider_key,
                    size: 32,
                    displayName: provider.display_name
                )

                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text(provider.display_name ?? provider.provider_key)
                        .font(VFont.titleSmall)
                        .foregroundStyle(VColor.contentEmphasized)
                        .lineLimit(1)
                        .truncationMode(.tail)

                    if let description = provider.description, !description.isEmpty {
                        Text(description)
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(VColor.contentSecondary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                }

                Spacer()

                if isConnected {
                    VButton(label: "Manage", rightIcon: VIcon.chevronDown.rawValue, style: .outlined) {
                        if isMenuOpen {
                            activePanel?.close()
                            activePanel = nil
                            isMenuOpen = false
                        } else {
                            showMenu()
                        }
                    }
                    .overlay {
                        GeometryReader { geo in
                            Color.clear
                                .onAppear { triggerFrame = geo.frame(in: .global) }
                                .onChange(of: geo.frame(in: .global)) { _, newFrame in
                                    triggerFrame = newFrame
                                }
                        }
                    }
                } else {
                    VButton(label: "Enable", style: .primary) {
                        onEnable()
                    }
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func showMenu() {
        guard !isMenuOpen else { return }
        isMenuOpen = true

        NSApp.keyWindow?.makeFirstResponder(nil)

        guard let window = NSApp.keyWindow ?? NSApp.windows.first(where: { $0.isVisible }) else {
            isMenuOpen = false
            return
        }

        let triggerInWindow = CGPoint(x: triggerFrame.minX, y: triggerFrame.maxY)
        let screenPoint = window.convertPoint(toScreen: NSPoint(
            x: triggerInWindow.x,
            y: window.frame.height - triggerInWindow.y
        ))

        let triggerScreenOrigin = window.convertPoint(toScreen: NSPoint(
            x: triggerFrame.minX,
            y: window.frame.height - triggerFrame.maxY
        ))
        let triggerScreenRect = CGRect(
            origin: triggerScreenOrigin,
            size: CGSize(width: triggerFrame.width, height: triggerFrame.height)
        )

        let appearance = window.effectiveAppearance
        activePanel = VMenuPanel.show(at: screenPoint, sourceAppearance: appearance, excludeRect: triggerScreenRect) {
            VMenu(width: 200) {
                VMenuItem(icon: VIcon.pencil.rawValue, label: "Edit connection") {
                    onEdit()
                }
                VMenuItem(icon: VIcon.circleX.rawValue, label: "Disable", variant: .destructive) {
                    onDisable()
                }
            }
        } onDismiss: {
            isMenuOpen = false
            activePanel = nil
        }
    }
}
