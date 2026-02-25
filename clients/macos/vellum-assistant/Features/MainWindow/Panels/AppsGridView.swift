import SwiftUI
import VellumAssistantShared

/// Full-screen apps grid view showing all apps as an icon grid with search and pinned/recent sections.
/// Home Base always appears as the first item in the Pinned section.
struct AppsGridView: View {
    @ObservedObject var appListManager: AppListManager
    let daemonClient: DaemonClient
    let onOpenApp: (String) -> Void
    var onOpenHomeBase: (() -> Void)?

    @State private var searchText = ""
    @State private var hoveredAppId: String?
    @State private var recentVisibleCount = 10
    @State private var editingApp: AppListManager.AppItem?

    private let columns = Array(repeating: GridItem(.flexible(), spacing: VSpacing.xl), count: 5)

    /// Whether "Home Base" matches the current search query.
    private var homeBaseMatchesSearch: Bool {
        guard !searchText.isEmpty else { return true }
        return "Home Base".localizedCaseInsensitiveContains(searchText)
    }

    var body: some View {
        ScrollView {
            VStack(spacing: VSpacing.xl) {
                searchBar
                    .padding(.top, VSpacing.xxl)

                // Pinned section: Home Base is always the first item
                let showPinned = homeBaseMatchesSearch || !filteredPinnedApps.isEmpty
                if showPinned {
                    pinnedSectionView
                }

                if !filteredRecentApps.isEmpty {
                    recentSectionView
                }

                if !showPinned && filteredRecentApps.isEmpty && !searchText.isEmpty {
                    VEmptyState(
                        title: "No apps matched",
                        subtitle: "No apps matched \"\(searchText)\"",
                        icon: "magnifyingglass"
                    )
                    .frame(maxWidth: .infinity)
                    .padding(.top, VSpacing.xxxl)
                }
            }
            .padding(.horizontal, VSpacing.xxl)
            .padding(.bottom, VSpacing.xxl)
        }
        .background(VColor.backgroundSubtle)
        .sheet(item: $editingApp) { app in
            let iconInfo = resolvedIcon(for: app)
            AppIconPickerSheet(
                appName: app.name,
                currentSymbol: iconInfo.sfSymbol,
                currentColors: iconInfo.colors,
                onSave: { symbol, colors in
                    appListManager.updateAppIcon(id: app.id, sfSymbol: symbol, iconBackground: colors)
                }
            )
        }
    }

    // MARK: - Search Bar

    private var searchBar: some View {
        GeometryReader { geometry in
            HStack {
                Spacer()
                HStack(spacing: VSpacing.sm) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(VColor.textMuted)

                    TextField("Search apps...", text: $searchText)
                        .textFieldStyle(.plain)
                        .font(VFont.body)
                        .foregroundColor(VColor.textPrimary)

                    if !searchText.isEmpty {
                        Button(action: { searchText = "" }) {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 12))
                                .foregroundColor(VColor.textMuted)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Clear search")
                    }
                }
                .padding(.horizontal, VSpacing.lg)
                .padding(.vertical, VSpacing.sm)
                .background(VColor.surface)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.pill))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.pill)
                        .stroke(VColor.surfaceBorder, lineWidth: 1)
                )
                .frame(maxWidth: geometry.size.width * 0.6)
                Spacer()
            }
        }
        .frame(height: 36)
    }

    // MARK: - Sections

    /// Pinned section with Home Base as the first item followed by user-pinned apps.
    private var pinnedSectionView: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            Text("PINNED")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
                .tracking(1.2)
                .padding(.leading, VSpacing.xs)

            LazyVGrid(columns: columns, spacing: VSpacing.xl) {
                if homeBaseMatchesSearch {
                    homeBaseGridItem
                }
                ForEach(filteredPinnedApps) { app in
                    appGridItem(app)
                }
            }
        }
    }

    private func sectionView(title: String, apps: [AppListManager.AppItem]) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            Text(title)
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
                .tracking(1.2)
                .padding(.leading, VSpacing.xs)

            LazyVGrid(columns: columns, spacing: VSpacing.xl) {
                ForEach(apps) { app in
                    appGridItem(app)
                }
            }
        }
    }

    private var recentSectionView: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            Text("RECENT")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
                .tracking(1.2)
                .padding(.leading, VSpacing.xs)

            let visibleRecent = Array(filteredRecentApps.prefix(recentVisibleCount))

            LazyVGrid(columns: columns, spacing: VSpacing.xl) {
                ForEach(visibleRecent) { app in
                    appGridItem(app)
                }
            }

            if filteredRecentApps.count > recentVisibleCount {
                HStack {
                    Spacer()
                    Button {
                        withAnimation(VAnimation.standard) {
                            recentVisibleCount += 10
                        }
                    } label: {
                        Text("Show more")
                            .font(VFont.caption)
                            .foregroundColor(VColor.accent)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Show more recent apps")
                    Spacer()
                }
                .padding(.top, VSpacing.sm)
            }
        }
    }

    // MARK: - Grid Item

    private func appGridItem(_ app: AppListManager.AppItem) -> some View {
        let isHovered = hoveredAppId == app.id
        let iconInfo = resolvedIcon(for: app)

        return Button {
            appListManager.recordAppOpen(
                id: app.id, name: app.name, icon: app.icon,
                previewBase64: app.previewBase64, appType: app.appType
            )
            onOpenApp(app.id)
        } label: {
            VStack(spacing: VSpacing.sm) {
                VAppIcon(
                    sfSymbol: iconInfo.sfSymbol,
                    gradientColors: iconInfo.colors,
                    size: .medium
                )

                Text(app.name)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity)
                    .multilineTextAlignment(.center)
            }
        }
        .buttonStyle(.plain)
        .scaleEffect(isHovered ? 1.05 : 1.0)
        .animation(VAnimation.fast, value: isHovered)
        .onHover { hovering in
            hoveredAppId = hovering ? app.id : nil
        }
        .contextMenu {
            Button("Open") {
                onOpenApp(app.id)
            }
            Button(app.isPinned ? "Unpin" : "Pin") {
                if app.isPinned {
                    appListManager.unpinApp(id: app.id)
                } else {
                    appListManager.pinApp(id: app.id)
                }
            }
            Button("Change Icon") {
                editingApp = app
            }
        }
        .accessibilityLabel(app.name)
    }

    // MARK: - Home Base Item

    private static let homeBaseId = "__home_base__"

    private var homeBaseGridItem: some View {
        let isHovered = hoveredAppId == Self.homeBaseId

        return Button {
            onOpenHomeBase?()
        } label: {
            VStack(spacing: VSpacing.sm) {
                VAppIcon(
                    sfSymbol: "house.fill",
                    gradientColors: ["#7C3AED", "#4F46E5"],
                    size: .medium
                )
                .overlay(alignment: .topTrailing) {
                    // Small home badge in the top-right corner
                    ZStack {
                        Circle()
                            .fill(Color(hexString: "#4F46E5"))
                            .frame(width: 18, height: 18)
                        Image(systemName: "house.fill")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundColor(.white)
                    }
                    .offset(x: 4, y: -4)
                }

                Text("Home Base")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity)
                    .multilineTextAlignment(.center)
            }
        }
        .buttonStyle(.plain)
        .scaleEffect(isHovered ? 1.05 : 1.0)
        .animation(VAnimation.fast, value: isHovered)
        .onHover { hovering in
            hoveredAppId = hovering ? Self.homeBaseId : nil
        }
        .accessibilityLabel("Home Base")
    }

    // MARK: - Helpers

    private func resolvedIcon(for app: AppListManager.AppItem) -> (sfSymbol: String, colors: [String]) {
        if let symbol = app.sfSymbol, let colors = app.iconBackground, !colors.isEmpty {
            return (sfSymbol: symbol, colors: colors)
        }
        return VAppIconGenerator.generate(from: app.name, type: app.appType)
    }

    /// Exclude any app that is the Home Base from the regular sections
    /// (since Home Base is always shown as a dedicated synthetic first item).
    private func isHomeBaseApp(_ app: AppListManager.AppItem) -> Bool {
        app.name.caseInsensitiveCompare("Home Base") == .orderedSame
    }

    private var filteredPinnedApps: [AppListManager.AppItem] {
        let pinned = appListManager.displayApps.filter { $0.isPinned && !isHomeBaseApp($0) }
        guard !searchText.isEmpty else { return pinned }
        return pinned.filter { $0.name.localizedCaseInsensitiveContains(searchText) }
    }

    private var filteredRecentApps: [AppListManager.AppItem] {
        let unpinned = appListManager.displayApps.filter { !$0.isPinned && !isHomeBaseApp($0) }
            .sorted { ($0.lastOpenedAt) > ($1.lastOpenedAt) }
        guard !searchText.isEmpty else { return unpinned }
        return unpinned.filter { $0.name.localizedCaseInsensitiveContains(searchText) }
    }
}

// MARK: - Preview

struct AppsGridView_Previews: PreviewProvider {
    struct PreviewWrapper: View {
        @StateObject private var appListManager = AppListManager()

        var body: some View {
            AppsGridView(
                appListManager: appListManager,
                daemonClient: DaemonClient(),
                onOpenApp: { _ in },
                onOpenHomeBase: {}
            )
            .onAppear {
                appListManager.recordAppOpen(id: "1", name: "Weather", icon: nil, appType: "app")
                appListManager.recordAppOpen(id: "2", name: "Notes", icon: nil, appType: "app")
                appListManager.recordAppOpen(id: "3", name: "Calendar", icon: nil, appType: "app")
                appListManager.recordAppOpen(id: "4", name: "Music", icon: nil, appType: "app")
                appListManager.recordAppOpen(id: "5", name: "Photos", icon: nil, appType: "site")
                appListManager.recordAppOpen(id: "6", name: "Maps", icon: nil, appType: "app")
                appListManager.pinApp(id: "1")
                appListManager.pinApp(id: "2")
            }
        }
    }

    static var previews: some View {
        ZStack {
            VColor.background.ignoresSafeArea()
            PreviewWrapper()
        }
        .frame(width: 800, height: 600)
    }
}
