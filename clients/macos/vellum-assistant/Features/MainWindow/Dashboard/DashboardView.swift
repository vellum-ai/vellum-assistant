import SwiftUI
import VellumAssistantShared

/// The main dashboard view that replaces the placeholder. Displays a greeting,
/// weather card, starter task cards, and deferred permission cards. Supports
/// theme color persistence via `@AppStorage`.
struct DashboardView: View {
    let onTaskKickoff: (DashboardTask) -> Void

    @StateObject private var weatherService = DashboardWeatherService()
    @AppStorage("dashboardAccentColorHex") private var accentColorHex: String = ""
    @AppStorage("dashboardAccentColorName") private var accentColorName: String = ""
    @State private var showDeferredSection = false

    private var accentColor: Color? {
        guard !accentColorHex.isEmpty else { return nil }
        return Color(hex: accentColorHex)
    }

    private var greetingText: String {
        let hour = Calendar.current.component(.hour, from: Date())
        switch hour {
        case 5..<12: return "Good morning"
        case 12..<17: return "Good afternoon"
        case 17..<22: return "Good evening"
        default: return "Good evening"
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VSpacing.section) {
                // Greeting
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    Text(greetingText)
                        .font(VFont.panelTitle)
                        .foregroundColor(VColor.textPrimary)

                    if !accentColorName.isEmpty {
                        HStack(spacing: VSpacing.sm) {
                            Circle()
                                .fill(accentColor ?? VColor.accent)
                                .frame(width: 10, height: 10)
                            Text("Theme: \(accentColorName)")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                        }
                    }
                }

                // Weather card
                DashboardWeatherCard(weatherService: weatherService)

                // Starter tasks
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    Text("GET STARTED")
                        .font(VFont.headline)
                        .foregroundColor(VColor.textMuted)

                    LazyVGrid(
                        columns: [
                            GridItem(.flexible(), spacing: VSpacing.md),
                            GridItem(.flexible(), spacing: VSpacing.md),
                            GridItem(.flexible(), spacing: VSpacing.md),
                        ],
                        spacing: VSpacing.md
                    ) {
                        ForEach(DashboardTask.starterTasks) { task in
                            DashboardTaskCard(
                                task: task,
                                accentColor: accentColor,
                                onTap: { onTaskKickoff(task) }
                            )
                        }
                    }
                }

                // Deferred permission tasks
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    Button {
                        withAnimation(VAnimation.standard) {
                            showDeferredSection.toggle()
                        }
                    } label: {
                        HStack(spacing: VSpacing.sm) {
                            Text("MORE OPTIONS")
                                .font(VFont.headline)
                                .foregroundColor(VColor.textMuted)

                            Image(systemName: showDeferredSection ? "chevron.up" : "chevron.down")
                                .font(.system(size: 10, weight: .medium))
                                .foregroundColor(VColor.textMuted)

                            Spacer()
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)

                    if showDeferredSection {
                        LazyVGrid(
                            columns: [
                                GridItem(.flexible(), spacing: VSpacing.md),
                                GridItem(.flexible(), spacing: VSpacing.md),
                                GridItem(.flexible(), spacing: VSpacing.md),
                            ],
                            spacing: VSpacing.md
                        ) {
                            ForEach(DashboardTask.deferredPermissionTasks) { task in
                                DashboardTaskCard(
                                    task: task,
                                    accentColor: accentColor,
                                    onTap: { onTaskKickoff(task) }
                                )
                            }
                        }
                        .transition(.opacity.combined(with: .move(edge: .top)))
                    }
                }

                Spacer(minLength: VSpacing.xxxl)
            }
            .padding(.horizontal, VSpacing.page)
            .padding(.top, VSpacing.xl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(VColor.background)
        .onAppear {
            weatherService.fetchIfNeeded()
        }
        .onReceive(NotificationCenter.default.publisher(for: .dashboardThemeDidUpdate)) { notification in
            if let colorHex = notification.userInfo?["colorHex"] as? String {
                accentColorHex = colorHex
            }
            if let colorName = notification.userInfo?["colorName"] as? String {
                accentColorName = colorName
            }
        }
    }
}

// MARK: - Color hex initializer

private extension Color {
    /// Initialize a Color from a CSS hex string (e.g. "#1E90FF" or "1E90FF").
    init(hex string: String) {
        let hex = string.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        var int: UInt64 = 0
        Scanner(string: hex).scanHexInt64(&int)
        let r, g, b: Double
        switch hex.count {
        case 6:
            r = Double((int >> 16) & 0xFF) / 255
            g = Double((int >> 8) & 0xFF) / 255
            b = Double(int & 0xFF) / 255
        default:
            r = 0; g = 0; b = 0
        }
        self.init(.sRGB, red: r, green: g, blue: b, opacity: 1)
    }
}

// MARK: - Notification Name

extension Notification.Name {
    /// Posted when a `dashboard_theme_update` message is received from the daemon.
    static let dashboardThemeDidUpdate = Notification.Name("dashboardThemeDidUpdate")
}
