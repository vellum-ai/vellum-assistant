#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// Slide-in drawer that hosts `ConversationListView` on compact size classes.
///
/// The drawer reuses the existing conversation list verbatim (its rows, search,
/// archive, swipe actions, and schedule groupings are unchanged). It only
/// supplies the drawer chrome — a close button, a footer Settings entry point —
/// and the callback plumbing that routes row taps up to
/// `IOSRootNavigationView` instead of pushing a NavigationLink.
///
/// Apple references consulted (2026-04-20):
/// - Human Interface Guidelines — [Navigation](https://developer.apple.com/design/human-interface-guidelines/navigation)
/// - [`NavigationStack`](https://developer.apple.com/documentation/swiftui/navigationstack)
/// - [`accessibilityAddTraits(_:)`](https://developer.apple.com/documentation/swiftui/view/accessibilityaddtraits(_:))
///   (the drawer behaves like a modal surface; `isModal` prevents VoiceOver
///   from reaching content behind it)
struct ConversationDrawerView: View {
    @ObservedObject var store: IOSConversationStore
    let onSelectConversation: (UUID) -> Void
    let onShowSettings: () -> Void
    let onClose: () -> Void
    @Binding var activeConversationId: UUID?

    var body: some View {
        NavigationStack {
            ConversationListView(
                store: store,
                onSelectConversation: onSelectConversation,
                onShowSettings: onShowSettings,
                selectedConversationId: $activeConversationId
            )
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: onClose) {
                        VIconView(.x, size: 20)
                    }
                    .accessibilityLabel("Close menu")
                }
            }
            .safeAreaInset(edge: .bottom) {
                drawerFooter
            }
        }
        .background(VColor.surfaceBase)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
    }

    private var drawerFooter: some View {
        HStack(spacing: VSpacing.md) {
            Button {
                onShowSettings()
            } label: {
                HStack(spacing: VSpacing.sm) {
                    VIconView(.settings, size: 18)
                    Text("Settings")
                        .font(VFont.bodyMediumEmphasised)
                }
                .foregroundStyle(VColor.contentDefault)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, VSpacing.sm)
            }
            .accessibilityLabel("Settings")
            .accessibilityHint("Opens the Settings sheet")

            Spacer(minLength: 0)
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
        .background(
            VColor.surfaceBase
                .overlay(alignment: .top) {
                    Rectangle()
                        .fill(VColor.borderBase)
                        .frame(height: 0.5)
                }
        )
    }
}
#endif
