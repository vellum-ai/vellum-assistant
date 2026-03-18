import VellumAssistantShared
import Combine
import SwiftUI

/// Active observation session view — shows a timer countdown and running narration
/// of what the assistant "sees" while observing the user work.
/// Screen capture is stubbed; narration uses placeholder messages.
@MainActor
struct ObservationSessionView: View {
    @Bindable var state: OnboardingState
    var onComplete: () -> Void
    var onStopEarly: () -> Void

    @State private var remainingSeconds: Int = 0
    @State private var totalSeconds: Int = 0
    @State private var timerActive: Bool = false
    @State private var narrationMessages: [InterviewMessage] = []
    @State private var narrationIndex: Int = 0
    @State private var stopped = false

    /// Stub narration messages that simulate the assistant describing what it sees.
    private static let stubNarrations: [String] = [
        "Okay, I\u{2019}m watching\u{2026} I see you have a few apps open. Interesting workflow.",
        "You seem to switch between your browser and editor a lot \u{2014} I can help streamline that.",
        "I notice you tend to organize things in a specific way. I\u{2019}ll remember that.",
        "Got it \u{2014} you like to keep things tidy. I can work with that style.",
        "Almost done! I\u{2019}m getting a good picture of how you work.",
    ]

    private var progress: Double {
        guard totalSeconds > 0 else { return 0 }
        return 1.0 - (Double(remainingSeconds) / Double(totalSeconds))
    }

    private var timeDisplay: String {
        let minutes = remainingSeconds / 60
        let seconds = remainingSeconds % 60
        return String(format: "%d:%02d", minutes, seconds)
    }

    var body: some View {
        HStack(alignment: .center, spacing: VSpacing.xxxl) {
            // Creature on the left with "watching" indicator
            VStack(spacing: VSpacing.md) {
                CreatureView(visible: true, animated: false)
                    .scaleEffect(0.5)
                    .frame(width: 200, height: 200)

                HStack(spacing: VSpacing.xs) {
                    Circle()
                        .fill(VColor.systemPositiveStrong)
                        .frame(width: 8, height: 8)
                        .opacity(pulseOpacity)

                Text("Observing")
                    .font(VFont.captionMedium)
                    .foregroundColor(VColor.systemPositiveStrong)
                    .textSelection(.enabled)
                }
            }

            OnboardingPanel {
                VStack(alignment: .leading, spacing: VSpacing.xl) {
                    // Timer header
                    HStack {
                        VStack(alignment: .leading, spacing: VSpacing.xxs) {
                            Text("Observation in progress")
                                .font(VFont.headline)
                                .foregroundColor(VColor.contentDefault)
                                .textSelection(.enabled)

                            Text("\(timeDisplay) remaining")
                                .font(VFont.mono)
                                .foregroundColor(VColor.contentSecondary)
                                .textSelection(.enabled)
                        }

                        Spacer()

                        // Circular progress indicator
                        ZStack {
                            Circle()
                                .stroke(VColor.borderBase, lineWidth: 3)
                                .frame(width: 40, height: 40)

                            Circle()
                                .trim(from: 0, to: progress)
                                .stroke(VColor.primaryBase, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                                .frame(width: 40, height: 40)
                                .rotationEffect(.degrees(-90))
                                .animation(VAnimation.standard, value: progress)

                            VIconView(.eye, size: 14)
                                .foregroundColor(VColor.primaryBase)
                        }
                    }

                    // Progress bar
                    GeometryReader { geometry in
                        ZStack(alignment: .leading) {
                            RoundedRectangle(cornerRadius: VRadius.xs)
                                .fill(VColor.borderBase)
                                .frame(height: 4)

                            RoundedRectangle(cornerRadius: VRadius.xs)
                                .fill(VColor.primaryBase)
                                .frame(width: geometry.size.width * progress, height: 4)
                                .animation(VAnimation.standard, value: progress)
                        }
                    }
                    .frame(height: 4)

                    // Narration messages
                    ScrollViewReader { proxy in
                        ScrollView {
                            LazyVStack(spacing: VSpacing.md) {
                                ForEach(narrationMessages) { message in
                                    NarrationBubble(text: message.text)
                                        .id(message.id)
                                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                                }
                            }
                            .padding(.vertical, VSpacing.xs)
                        }
                        .frame(maxHeight: 200)
                        .onChange(of: narrationMessages.count) {
                            withAnimation(VAnimation.standard) {
                                if let last = narrationMessages.last {
                                    proxy.scrollTo(last.id, anchor: .bottom)
                                }
                            }
                        }
                    }

                    // Stop early button
                    OnboardingButton(
                        title: "Stop early",
                        style: .tertiary
                    ) {
                        stopObservation()
                        onStopEarly()
                    }
                }
            }
            .frame(maxWidth: 420)
        }
        .onAppear {
            startObservation()
        }
        .onDisappear {
            timerActive = false
        }
        .onReceive(Timer.publish(every: 1.0, on: .main, in: .common).autoconnect()) { _ in
            guard timerActive else { return }
            if remainingSeconds > 0 {
                remainingSeconds -= 1
            } else {
                stopObservation()
                onComplete()
            }
        }
    }

    // MARK: - Pulse Animation

    @State private var pulseOpacity: Double = 1.0

    private func startPulse() {
        withAnimation(.easeInOut(duration: 1.0).repeatForever(autoreverses: true)) {
            pulseOpacity = 0.3
        }
    }

    // MARK: - Observation Logic

    private func startObservation() {
        let minutes = state.observationDurationMinutes
        totalSeconds = minutes * 60
        remainingSeconds = totalSeconds

        startPulse()

        // Add initial narration after a short delay
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [self] in
            guard !stopped else { return }
            addNextNarration()
        }

        // Start countdown timer
        timerActive = true

        // Schedule narration messages at intervals
        let narrationInterval = max(Double(totalSeconds) / Double(Self.stubNarrations.count), 15.0)
        for i in 1..<Self.stubNarrations.count {
            DispatchQueue.main.asyncAfter(deadline: .now() + narrationInterval * Double(i) + 2.0) { [self] in
                guard !stopped else { return }
                addNextNarration()
            }
        }
    }

    private func addNextNarration() {
        guard narrationIndex < Self.stubNarrations.count else { return }
        let text = Self.stubNarrations[narrationIndex]
        narrationIndex += 1

        withAnimation(VAnimation.standard) {
            narrationMessages.append(
                InterviewMessage(role: .assistant, text: text)
            )
        }

        // Store as observation insight
        state.observationInsights.append(text)
    }

    private func stopObservation() {
        stopped = true
        timerActive = false
    }
}

// MARK: - Narration Bubble

private struct NarrationBubble: View {
    let text: String

    var body: some View {
        HStack {
            HStack(spacing: VSpacing.sm) {
                VIconView(.eye, size: 11)
                    .foregroundColor(VColor.primaryBase)

                Text(text)
                    .font(VFont.body)
                    .foregroundColor(VColor.contentDefault)
                    .textSelection(.enabled)
            }
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
