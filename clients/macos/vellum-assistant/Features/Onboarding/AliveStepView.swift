import VellumAssistantShared
import SwiftUI

@MainActor
struct AliveStepView: View {
    @Bindable var state: OnboardingState
    var onComplete: () -> Void
    var onOpenSettings: () -> Void

    @State private var showAbilities = false
    @State private var showButtons = false

    private var abilities: [(String, String)] {
        [
            ("Voice conversations", "mic.fill"),
            ("Takes action for you", "hand.tap.fill"),
            ("Context-aware help", "brain.head.profile"),
            ("Hold \(state.chosenKey.displayName) to activate", "keyboard"),
        ]
    }

    var body: some View {
        VStack(spacing: VSpacing.xl) {
            VStack(spacing: VSpacing.md) {
                Text("\(state.assistantName.isEmpty ? "It" : state.assistantName) has hatched.")
                    .font(VFont.onboardingTitle)
                    .foregroundColor(VColor.contentDefault)
                    .textSelection(.enabled)

                Text("All set up and ready to help.")
                    .font(VFont.onboardingSubtitle)
                    .foregroundColor(VColor.contentSecondary)
                    .textSelection(.enabled)
            }

            // Ability tags — 2x2 grid
            VStack(spacing: VSpacing.md + VSpacing.xxs) {
                ForEach([0, 2], id: \.self) { row in
                    HStack(spacing: VSpacing.md + VSpacing.xxs) {
                        ForEach(row..<min(row + 2, abilities.count), id: \.self) { index in
                            abilityTag(abilities[index].0, icon: abilities[index].1)
                                .opacity(showAbilities ? 1 : 0)
                                .offset(y: showAbilities ? 0 : 10)
                                .animation(
                                    .easeOut(duration: 0.4).delay(Double(index) * 0.15),
                                    value: showAbilities
                                )
                        }
                    }
                }
            }

            VStack(spacing: VSpacing.md) {
                OnboardingButton(
                    title: "Start using \(state.assistantName.isEmpty ? "your agent" : state.assistantName)",
                    style: .primary
                ) {
                    onComplete()
                }

                Button {
                    onOpenSettings()
                } label: {
                    Text("Open Settings first")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                }
                .buttonStyle(.plain)
                .pointerCursor()
            }
            .opacity(showButtons ? 1 : 0)

            if state.anyPermissionDenied {
                Text("Some abilities are limited \u{2014} you can enable them in Settings anytime.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
                    .multilineTextAlignment(.center)
                    .textSelection(.enabled)
                    .opacity(showButtons ? 1 : 0)
            }
        }
        .onAppear {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                showAbilities = true
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) {
                withAnimation(.easeOut(duration: 0.5)) {
                    showButtons = true
                }
            }
        }
    }

    private func abilityTag(_ title: String, icon: String) -> some View {
        HStack(spacing: VSpacing.sm) {
            VIconView(SFSymbolMapping.icon(forSFSymbol: icon, fallback: .puzzle), size: 11)
            Text(title)
                .font(VFont.captionMedium)
                .textSelection(.enabled)
        }
        .foregroundColor(VColor.contentDefault.opacity(0.8))
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
        .background(
            Capsule()
                .fill(VColor.surfaceBase.opacity(0.5))
                .overlay(
                    Capsule()
                        .stroke(VColor.borderBase.opacity(0.4), lineWidth: 1)
                )
        )
    }
}
