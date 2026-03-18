import SwiftUI
import VellumAssistantShared

/// Tab selection for the combined Contacts + Intelligence panel.
enum ContactsPanelTab: String, CaseIterable {
    case contacts = "Contacts"
    case intelligence = "Intelligence"
}

/// Combined panel with tabs for Contacts and Intelligence content.
struct ContactsIntelligencePanel<ContactsContent: View, IntelligenceContent: View>: View {
    @Binding var selectedTab: ContactsPanelTab
    var onClose: () -> Void
    @ViewBuilder var contactsContent: () -> ContactsContent
    @ViewBuilder var intelligenceContent: () -> IntelligenceContent

    var body: some View {
        VStack(spacing: 0) {
            // Header with tab bar and close button
            HStack {
                HStack(spacing: VSpacing.lg) {
                    ForEach(ContactsPanelTab.allCases, id: \.self) { tab in
                        Button {
                            selectedTab = tab
                        } label: {
                            Text(tab.rawValue)
                                .font(selectedTab == tab ? VFont.panelTitle : VFont.body)
                                .foregroundColor(selectedTab == tab ? VColor.contentDefault : VColor.contentTertiary)
                        }
                        .buttonStyle(.plain)
                        .pointerCursor()
                    }
                }
                Spacer()
                VButton(label: "Close", iconOnly: "xmark", style: .ghost) {
                    onClose()
                }
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.lg)

            Divider().background(VColor.borderBase)

            // Content
            switch selectedTab {
            case .contacts:
                contactsContent()
            case .intelligence:
                intelligenceContent()
            }
        }
    }
}
