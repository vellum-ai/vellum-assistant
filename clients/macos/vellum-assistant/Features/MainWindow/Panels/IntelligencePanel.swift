import SwiftUI
import VellumAssistantShared

// MARK: - Intelligence Panel

struct IntelligencePanel: View {
    var onClose: () -> Void
    var onInvokeSkill: ((SkillInfo) -> Void)?
    let daemonClient: DaemonClient

    @State private var selectedTab: IntelligenceTab = .identity

    private enum IntelligenceTab: String, CaseIterable {
        case identity = "Identity"
        case installedSkills = "Skills"
        case workspace = "Workspace"
        case memories = "Memories"
    }

    private let maxContentWidth: CGFloat = 1100

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            HStack(alignment: .center) {
                Text("Intelligence")
                    .font(VFont.panelTitle)
                    .foregroundColor(VColor.contentEmphasized)
                Spacer()
            }
            .padding(.bottom, VSpacing.md)

            // Tab bar
            VStack(spacing: 0) {
                HStack(spacing: VSpacing.xl) {
                    ForEach(IntelligenceTab.allCases, id: \.self) { tab in
                        tabButton(tab.rawValue, tab: tab)
                    }
                    Spacer()
                }

                Divider().background(VColor.borderDisabled)
            }
            .padding(.top, VSpacing.md)
            .padding(.bottom, VSpacing.md)

            // Tab content
            tabContent
                .padding(.top, VSpacing.sm)
        }
        .padding(VSpacing.xl)
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
                    .foregroundColor(isActive ? VColor.primaryActive : VColor.contentSecondary)
                    .padding(.bottom, VSpacing.xs)

                Rectangle()
                    .fill(isActive ? VColor.borderActive : Color.clear)
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
                daemonClient: daemonClient
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .clipped()

        case .installedSkills:
            AgentPanelContent(
                onInvokeSkill: onInvokeSkill,
                daemonClient: daemonClient
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)

        case .workspace:
            WorkspacePanel(daemonClient: daemonClient)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)

        case .memories:
            MemoriesPanel(daemonClient: daemonClient)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        }
    }
}

#Preview {
    IntelligencePanel(onClose: {}, daemonClient: DaemonClient())
}
