import SpriteKit
import SwiftUI

@MainActor
struct FirstMeetingFlowView: View {
    @Bindable var state: OnboardingState
    let daemonClient: DaemonClientProtocol
    var onComplete: () -> Void
    var onOpenSettings: () -> Void

    /// Shared SpriteKit scene for the egg/hatch animation across steps 0-1.
    @State private var eggScene: EggHatchScene = {
        let s = EggHatchScene()
        s.size = CGSize(width: 280, height: 480)
        s.scaleMode = .resizeFill
        s.backgroundColor = .clear
        return s
    }()

    var body: some View {
        ZStack {
            VColor.background
                .ignoresSafeArea()

            // Dimmed mock chrome — gives the "chat UI behind" effect
            VStack(spacing: 0) {
                mockToolbar
                Spacer()
                mockInputBar
            }
            .opacity(0.25)
            .allowsHitTesting(false)

            // Vertical card layout
            VStack(spacing: 0) {
                // TOP: Meadow background + egg scene
                ZStack {
                    MeadowBackground()

                    if state.currentStep <= 1 {
                        SpriteView(scene: eggScene, options: [.allowsTransparency])
                            .frame(width: 280, height: 350)
                            .allowsHitTesting(false)
                    }
                }
                .frame(height: 350)
                .clipped()
                .onAppear {
                    // Set initial crack progress without animation for restored sessions
                    let progress = state.firstMeetingCrackProgress
                    if progress > 0 {
                        eggScene.setCrackProgress(progress, animated: false)
                    }
                }

                // BOTTOM: Dark content panel
                VStack(spacing: VSpacing.lg) {
                    Group {
                        switch state.currentStep {
                        case 0:
                            FirstMeetingEggView(state: state)
                        case 1:
                            FirstMeetingHatchView(state: state, scene: eggScene)
                        case 2:
                            FirstMeetingIntroductionView(
                                state: state,
                                daemonClient: daemonClient,
                                onComplete: { state.advance() }
                            )
                        case 3:
                            CapabilitiesBriefingView(state: state, onComplete: { state.advance() })
                        case 4:
                            Text("Observation mode — coming soon")
                                .font(VFont.headline)
                                .foregroundColor(VColor.textPrimary)
                        default:
                            EmptyView()
                        }
                    }
                    .transition(
                        .asymmetric(
                            insertion: .opacity.combined(with: .offset(y: 12)),
                            removal: .opacity.combined(with: .offset(y: -8))
                        )
                    )
                    .id(state.currentStep)

                    OnboardingProgressDots(currentStep: state.currentStep)
                        .padding(.top, VSpacing.xs)
                }
                .padding(.horizontal, VSpacing.xxl)
                .padding(.top, VSpacing.xl)
                .padding(.bottom, VSpacing.xxl)
                .frame(maxWidth: .infinity)
                .background(
                    Rectangle()
                        .fill(.ultraThinMaterial)
                        .overlay(
                            Rectangle()
                                .fill(Meadow.panelBackground)
                        )
                )
            }
            .frame(maxWidth: 640)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.xl)
                    .stroke(Meadow.panelBorder, lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.4), radius: 24, y: 12)
            .padding(.vertical, VSpacing.xxxl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Mock Chrome

    private var mockToolbar: some View {
        HStack {
            HStack(spacing: 6) {
                Image(systemName: "bubble.left")
                    .font(.system(size: 11))
                Text("Chat")
                    .font(VFont.bodyMedium)
            }
            .foregroundColor(VColor.textPrimary)
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.sm)
            .background(VColor.surface.opacity(0.5))
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))

            Spacer()

            HStack(spacing: VSpacing.sm) {
                ForEach(["Automated", "Agent", "Control", "System"], id: \.self) { tab in
                    HStack(spacing: 4) {
                        Image(systemName: "circle")
                            .font(.system(size: 7))
                        Text(tab)
                    }
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                    .padding(.horizontal, VSpacing.md)
                    .padding(.vertical, VSpacing.sm)
                    .background(VColor.surface.opacity(0.3))
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                }
            }
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.top, 44) // below titlebar
    }

    private var mockInputBar: some View {
        HStack(spacing: VSpacing.md) {
            VCircleButton(icon: "phone.fill", label: "Phone", fillColor: Emerald._600.opacity(0.5)) { }

            Text("What you need chef?")
                .font(VFont.body)
                .foregroundColor(VColor.textMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, VSpacing.lg)
                .padding(.vertical, VSpacing.md)
                .background(VColor.surface.opacity(0.3))
                .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.bottom, VSpacing.lg)
    }
}

#Preview {
    FirstMeetingFlowView(
        state: OnboardingState(),
        daemonClient: DaemonClient(),
        onComplete: {},
        onOpenSettings: {}
    )
}
