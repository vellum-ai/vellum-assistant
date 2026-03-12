import SwiftUI
import VellumAssistantShared

/// Compact activity feed shown during workspace refinements.
/// Displays the user's message, thinking dots, and streaming AI response.
struct WorkspaceActivityFeed: View {
    @ObservedObject var viewModel: ChatViewModel
    @State private var appearance = AvatarAppearanceManager.shared

    var body: some View {
        if viewModel.refinementMessagePreview != nil {
            VStack(alignment: .trailing, spacing: VSpacing.md) {
                // User message bubble (right-aligned)
                if let preview = viewModel.refinementMessagePreview {
                    HStack {
                        Spacer(minLength: 0)
                        Text(preview)
                            .font(VFont.body)
                            .foregroundColor(VColor.auxWhite)
                            .padding(.horizontal, VSpacing.lg)
                            .padding(.vertical, VSpacing.md)
                            .background(
                                RoundedRectangle(cornerRadius: VRadius.md)
                                    .fill(
                                        LinearGradient(
                                            colors: [Meadow.userBubbleGradientStart, Meadow.userBubbleGradientEnd],
                                            startPoint: .topLeading,
                                            endPoint: .bottomTrailing
                                        )
                                    )
                            )
                            .vShadow(VShadow.accentGlow)
                            .frame(maxWidth: 320, alignment: .trailing)
                    }
                }

                // Thinking dots OR streaming assistant text
                if let streamingText = viewModel.refinementStreamingText {
                    // Streaming/completed assistant response
                    HStack(alignment: .top, spacing: VSpacing.sm) {
                        assistantAvatar

                        Text(TextResponseView.markdownString(streamingText))
                            .font(VFont.body)
                            .foregroundColor(VColor.contentDefault)
                            .textSelection(.enabled)
                            .padding(.horizontal, VSpacing.lg)
                            .padding(.vertical, VSpacing.md)
                            .background(
                                RoundedRectangle(cornerRadius: VRadius.md)
                                    .fill(VColor.surfaceBase.opacity(0.5))
                            )
                            .frame(maxWidth: 320, alignment: .leading)

                        Spacer(minLength: 0)
                    }
                } else if viewModel.isWorkspaceRefinementInFlight {
                    // Thinking dots
                    HStack(alignment: .top, spacing: VSpacing.sm) {
                        assistantAvatar

                        BouncingDots()
                            .padding(.horizontal, VSpacing.lg)
                            .padding(.vertical, VSpacing.md)
                            .background(
                                RoundedRectangle(cornerRadius: VRadius.md)
                                    .fill(VColor.surfaceBase.opacity(0.5))
                            )

                        Spacer(minLength: 0)
                    }
                }
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.md)
            .frame(maxWidth: 480)
            .background(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .fill(VColor.surfaceBase.opacity(0.95))
                    .overlay(RoundedRectangle(cornerRadius: VRadius.lg).stroke(VColor.borderBase, lineWidth: 1))
            )
            .overlay(alignment: .topTrailing) {
                Button {
                    viewModel.refinementMessagePreview = nil
                    viewModel.refinementStreamingText = nil
                } label: {
                    VIconView(.x, size: 10)
                        .foregroundColor(VColor.contentTertiary)
                }
                .buttonStyle(.plain)
                .padding(VSpacing.sm)
                .accessibilityLabel("Dismiss")
            }
            .transition(.opacity.combined(with: .move(edge: .bottom)))
            .animation(VAnimation.standard, value: viewModel.refinementMessagePreview != nil)
            .animation(VAnimation.standard, value: viewModel.refinementStreamingText != nil)
            .animation(VAnimation.standard, value: viewModel.isWorkspaceRefinementInFlight)
        }
    }

    private var assistantAvatar: some View {
        VAvatarImage(image: appearance.chatAvatarImage, size: 24)
    }
}
