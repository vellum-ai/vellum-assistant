import SwiftUI

struct SparkleParticle: Identifiable {
    let id = UUID()
    var x: CGFloat
    var y: CGFloat
    var opacity: Double
    var scale: CGFloat
}

struct AliveStepView: View {
    @Bindable var state: OnboardingState
    var onComplete: () -> Void
    var onOpenSettings: () -> Void

    @State private var showAbilities = false
    @State private var showButtons = false
    @State private var particles: [SparkleParticle] = []
    @State private var particlesLaunched = false

    private var abilities: [(String, String)] {
        [
            ("Voice conversations", "mic.fill"),
            ("Takes action for you", "hand.tap.fill"),
            ("Context-aware help", "brain.head.profile"),
            ("Hold \(state.chosenKey.displayName) to activate", "keyboard"),
        ]
    }

    var body: some View {
        VStack(spacing: VSpacing.xxxl) {
            ZStack {
                // Sparkle particles
                ForEach(particles) { particle in
                    Circle()
                        .fill(VColor.onboardingAccent)
                        .frame(width: 4, height: 4)
                        .scaleEffect(particle.scale)
                        .opacity(particle.opacity)
                        .offset(x: particle.x, y: particle.y)
                }
            }
            .frame(width: 140, height: 140)

            VStack(spacing: VSpacing.md) {
                Text("\(state.assistantName.isEmpty ? "It" : state.assistantName) has hatched.")
                    .font(VFont.onboardingTitle)
                    .foregroundColor(VColor.textPrimary)

                Text("All set up and ready to help.")
                    .font(VFont.onboardingSubtitle)
                    .foregroundColor(VColor.textSecondary)
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

            VStack(spacing: VSpacing.xl) {
                OnboardingButton(
                    title: "Start using \(state.assistantName.isEmpty ? "your agent" : state.assistantName)",
                    style: .primary
                ) {
                    onComplete()
                }
                .font(VFont.cardTitle)

                Button {
                    onOpenSettings()
                } label: {
                    Text("Open Settings first")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
                .buttonStyle(.plain)
                .onHover { hovering in
                    NSCursor.pointingHand.set()
                    if !hovering { NSCursor.arrow.set() }
                }
            }
            .opacity(showButtons ? 1 : 0)

            if state.anyPermissionDenied {
                Text("Some abilities are limited \u{2014} you can enable them in Settings anytime.")
                    .font(VFont.small)
                    .foregroundColor(VColor.textMuted)
                    .multilineTextAlignment(.center)
                    .opacity(showButtons ? 1 : 0)
            }

            Spacer()
                .frame(height: VSpacing.xxl)
        }
        .onAppear {
            state.orbMood = .celebrating
            launchSparkles()

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
            Image(systemName: icon)
                .font(VFont.small)
            Text(title)
                .font(VFont.captionMedium)
        }
        .foregroundColor(VColor.textPrimary.opacity(0.8))
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
        .background(
            Capsule()
                .fill(VColor.surface.opacity(0.5))
                .overlay(
                    Capsule()
                        .stroke(VColor.surfaceBorder.opacity(0.4), lineWidth: 1)
                )
        )
    }

    private func launchSparkles() {
        guard !particlesLaunched else { return }
        particlesLaunched = true

        for _ in 0..<16 {
            let angle = Double.random(in: 0...(2 * .pi))
            let distance = CGFloat.random(in: 40...80)
            let particle = SparkleParticle(
                x: 0,
                y: 0,
                opacity: 0.9,
                scale: CGFloat.random(in: 0.5...1.8)
            )
            particles.append(particle)

            let index = particles.count - 1
            withAnimation(.easeOut(duration: 1.2)) {
                particles[index].x = cos(angle) * distance
                particles[index].y = sin(angle) * distance
                particles[index].opacity = 0
                particles[index].scale = 0.2
            }
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) {
            particles.removeAll()
        }
    }
}

#Preview {
    ZStack {
        OnboardingBackground()
        AliveStepView(
            state: {
                let s = OnboardingState()
                s.currentStep = 5
                s.assistantName = "Alex"
                return s
            }(),
            onComplete: {},
            onOpenSettings: {}
        )
    }
    .frame(width: 600, height: 500)
}
