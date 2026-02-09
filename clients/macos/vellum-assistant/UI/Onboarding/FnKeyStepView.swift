import SwiftUI

struct FnKeyStepView: View {
    @Bindable var state: OnboardingState

    @State private var showButtons = false
    @State private var highlightedKey: ActivationKey?
    @State private var wrongKeyHint: String?
    @State private var eventMonitor: Any?
    @State private var nameReaction: String = ""

    private let keyOptions: [(key: ActivationKey, label: String)] = [
        (.fn, "\u{1F310} fn"),
        (.ctrl, "ctrl"),
    ]

    private static let nameReactions = [
        "%@\u{2026} that feels like mine.",
        "%@. I\u{2019}ll grow into it.",
        "%@ \u{2014} I already like the sound of it.",
    ]

    var body: some View {
        VStack(spacing: 24) {
            ReactionBubble(text: nameReaction)

            VStack(spacing: 8) {
                Text("Let\u{2019}s find your voice.")
                    .font(.system(.title2, design: .serif))
                    .foregroundColor(.white)

                Text("To call \(state.assistantName), you\u{2019}ll hold down a key. Try pressing it now \u{2014} which of these lights up?")
                    .font(.system(size: 15))
                    .foregroundColor(.white.opacity(0.6))
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 360)
            }
            .opacity(showButtons ? 1 : 0)

            HStack(spacing: 12) {
                ForEach(keyOptions, id: \.key) { option in
                    keyButton(option.key, label: option.label)
                }
            }
            .opacity(showButtons ? 1 : 0)

            if let hint = wrongKeyHint {
                Text(hint)
                    .font(.system(size: 13))
                    .foregroundColor(.white.opacity(0.5))
                    .transition(.opacity)
            }

            if highlightedKey != nil || state.chosenKey != .fn {
                OnboardingButton(title: "Continue", style: .primary) {
                    state.advance()
                }
                .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.3), value: wrongKeyHint)
        .animation(.easeOut(duration: 0.3), value: highlightedKey)
        .onAppear {
            let format = Self.nameReactions.randomElement()!
            nameReaction = String(format: format, state.assistantName)

            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                withAnimation(.easeOut(duration: 0.5)) {
                    showButtons = true
                }
            }
            startKeyMonitor()
        }
        .onDisappear {
            stopKeyMonitor()
        }
    }

    private func keyButton(_ key: ActivationKey, label: String) -> some View {
        Button {
            selectKey(key)
        } label: {
            Text(label)
                .font(.system(size: 16, weight: .medium, design: .monospaced))
                .foregroundColor(highlightedKey == key ? Color(hex: 0x0E0E11) : .white.opacity(0.85))
                .frame(width: 64, height: 44)
                .background(
                    RoundedRectangle(cornerRadius: 10)
                        .fill(highlightedKey == key ? Color(hex: 0xD4A843) : Color.white.opacity(0.08))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .stroke(highlightedKey == key ? Color.clear : Color.white.opacity(0.15), lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
    }

    private func selectKey(_ key: ActivationKey) {
        highlightedKey = key
        state.chosenKey = key
        wrongKeyHint = nil
    }

    private func startKeyMonitor() {
        eventMonitor = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { event in
            let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            if flags.contains(.function) {
                // fn / globe key (same physical key on modern Macs)
                selectKey(.fn)
            } else if flags.contains(.control) {
                selectKey(.ctrl)
            } else if flags.contains(.command) {
                withAnimation {
                    wrongKeyHint = "That\u{2019}s Cmd \u{2014} try fn or ctrl"
                }
                clearHintAfterDelay()
            } else if flags.contains(.option) {
                withAnimation {
                    wrongKeyHint = "Close! That\u{2019}s Option \u{2014} try fn or ctrl"
                }
                clearHintAfterDelay()
            }
            return event
        }
    }

    private func stopKeyMonitor() {
        if let monitor = eventMonitor {
            NSEvent.removeMonitor(monitor)
            eventMonitor = nil
        }
    }

    private func clearHintAfterDelay() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
            withAnimation {
                wrongKeyHint = nil
            }
        }
    }
}

#Preview {
    ZStack {
        OnboardingBackground()
        FnKeyStepView(state: {
            let s = OnboardingState()
            s.assistantName = "Alex"
            s.currentStep = 2
            return s
        }())
    }
    .frame(width: 600, height: 500)
}
