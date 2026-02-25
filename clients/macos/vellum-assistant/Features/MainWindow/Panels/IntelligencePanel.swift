import SwiftUI
import VellumAssistantShared

// MARK: - Intelligence Panel

/// Combined panel with three tabs: Identity, Installed Skills, and Community Skills.
struct IntelligencePanel: View {
    var onClose: () -> Void
    var onInvokeSkill: ((SkillInfo) -> Void)?
    var onCustomizeAvatar: () -> Void
    let daemonClient: DaemonClient

    /// Maximum width of the centered content area (matches AgentPanel).
    private let maxContentWidth: CGFloat = 1100

    private enum IntelligenceTab {
        case identity, installed, community
    }

    @State private var selectedIntelligenceTab: IntelligenceTab = .identity

    /// Maps the skills tabs to the AgentPanelContent binding.
    @State private var selectedSkillsTab: SkillsTab = .installed

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Scrollable header + tabs + content for identity; skills tabs fill remaining space
            if selectedIntelligenceTab == .identity {
                // Identity tab: full-bleed layout (sidebar + constellation), not in ScrollView
                VStack(alignment: .leading, spacing: 0) {
                    headerSection
                    tabBar
                    IdentityPanelContent(onCustomizeAvatar: onCustomizeAvatar, daemonClient: daemonClient)
                }
            } else {
                // Skills tabs: scrollable content with constrained width
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        headerSection
                        tabBar

                        AgentPanelContent(
                            onInvokeSkill: onInvokeSkill,
                            daemonClient: daemonClient,
                            selectedTab: $selectedSkillsTab,
                            showTabBar: false
                        )
                    }
                    .frame(maxWidth: maxContentWidth)
                    .padding(.horizontal, VSpacing.xxl)
                    .padding(.bottom, VSpacing.xxl)
                    .frame(maxWidth: .infinity)
                }
            }
        }
    }

    // MARK: - Header

    @ViewBuilder
    private var headerSection: some View {
        HStack(alignment: .center) {
            Text("Intelligence")
                .font(VFont.panelTitle)
                .foregroundColor(VColor.textPrimary)
            Spacer()
        }
        .padding(.top, VSpacing.xxl)
        .padding(.bottom, VSpacing.xl)
        .padding(.horizontal, VSpacing.xxl)

        Divider().background(VColor.surfaceBorder)
            .padding(.bottom, VSpacing.xl)
            .padding(.horizontal, VSpacing.xxl)
    }

    // MARK: - Tab Bar

    @ViewBuilder
    private var tabBar: some View {
        VStack(spacing: 0) {
            HStack(spacing: VSpacing.xl) {
                intelligenceTabButton("Identity", tab: .identity)
                intelligenceTabButton("Installed", tab: .installed)
                intelligenceTabButton("Community", tab: .community)
                Spacer()
            }

            Divider().background(VColor.surfaceBorder)
        }
        .padding(.bottom, VSpacing.lg)
        .padding(.horizontal, VSpacing.xxl)
    }

    @ViewBuilder
    private func intelligenceTabButton(_ label: String, tab: IntelligenceTab) -> some View {
        let isActive = selectedIntelligenceTab == tab
        Button {
            withAnimation(VAnimation.fast) {
                selectedIntelligenceTab = tab
                // Sync the skills tab binding when switching to a skills tab
                switch tab {
                case .installed:
                    selectedSkillsTab = .installed
                case .community:
                    selectedSkillsTab = .available
                case .identity:
                    break
                }
            }
        } label: {
            VStack(spacing: VSpacing.sm) {
                Text(label)
                    .font(VFont.body)
                    .foregroundColor(isActive ? VColor.textPrimary : VColor.textMuted)
                    .padding(.bottom, VSpacing.xs)

                Rectangle()
                    .fill(isActive ? VColor.textPrimary : Color.clear)
                    .frame(height: 2)
            }
            .fixedSize()
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

#Preview {
    IntelligencePanel(
        onClose: {},
        onCustomizeAvatar: {},
        daemonClient: DaemonClient()
    )
}
