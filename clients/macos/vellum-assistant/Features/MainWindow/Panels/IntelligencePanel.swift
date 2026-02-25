import SwiftUI
import VellumAssistantShared

// MARK: - Intelligence Panel

struct IntelligencePanel: View {
    var onClose: () -> Void
    var onCustomizeAvatar: () -> Void
    var onInvokeSkill: ((SkillInfo) -> Void)?
    let daemonClient: DaemonClient

    @State private var selectedTab: IntelligenceTab = .identity

    private enum IntelligenceTab: String, CaseIterable {
        case identity = "Identity"
        case installedSkills = "Installed Skills"
        case communitySkills = "Community Skills"
    }

    private let maxContentWidth: CGFloat = 1100

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header + tab bar (fixed at top)
            VStack(alignment: .leading, spacing: 0) {
                // Header
                HStack(alignment: .center) {
                    Text("Intelligence")
                        .font(VFont.panelTitle)
                        .foregroundColor(VColor.textPrimary)
                    Spacer()
                }
                .padding(.top, VSpacing.xxl)
                .padding(.bottom, VSpacing.xl)

                Divider().background(VColor.surfaceBorder)
                    .padding(.bottom, VSpacing.xl)

                // Tab bar
                VStack(spacing: 0) {
                    HStack(spacing: VSpacing.xl) {
                        ForEach(IntelligenceTab.allCases, id: \.self) { tab in
                            tabButton(tab.rawValue, tab: tab)
                        }
                        Spacer()
                    }

                    Divider().background(VColor.surfaceBorder)
                }
                .padding(.bottom, VSpacing.lg)
            }
            .frame(maxWidth: maxContentWidth)
            .padding(.horizontal, VSpacing.xxl)
            .frame(maxWidth: .infinity, alignment: .leading)

            // Tab content — each tab manages its own scrolling
            tabContent
        }
    }

    // MARK: - Tab Button

    @ViewBuilder
    private func tabButton(_ label: String, tab: IntelligenceTab) -> some View {
        let isActive = selectedTab == tab
        Button {
            withAnimation(VAnimation.fast) { selectedTab = tab }
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

    // MARK: - Tab Content

    @ViewBuilder
    private var tabContent: some View {
        switch selectedTab {
        case .identity:
            IdentityPanel(
                onClose: onClose,
                onCustomizeAvatar: onCustomizeAvatar,
                daemonClient: daemonClient
            )

        case .installedSkills:
            ScrollView {
                AgentPanelContent(
                    onInvokeSkill: onInvokeSkill,
                    daemonClient: daemonClient,
                    visibleTab: .installed
                )
                .frame(maxWidth: maxContentWidth)
                .padding(.horizontal, VSpacing.xxl)
                .padding(.bottom, VSpacing.xxl)
                .frame(maxWidth: .infinity)
            }

        case .communitySkills:
            ScrollView {
                AgentPanelContent(
                    onInvokeSkill: onInvokeSkill,
                    daemonClient: daemonClient,
                    visibleTab: .available
                )
                .frame(maxWidth: maxContentWidth)
                .padding(.horizontal, VSpacing.xxl)
                .padding(.bottom, VSpacing.xxl)
                .frame(maxWidth: .infinity)
            }
        }
    }
}

#Preview {
    IntelligencePanel(onClose: {}, onCustomizeAvatar: {}, daemonClient: DaemonClient())
}
