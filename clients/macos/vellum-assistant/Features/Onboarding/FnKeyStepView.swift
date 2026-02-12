import SwiftUI

@MainActor
struct FnKeyStepView: View {
    @Bindable var state: OnboardingState

    @State private var showButtons = false
    @State private var highlightedKey: ActivationKey?
    @State private var wrongKeyHint: String?
    @State private var eventMonitor: Any?

    private let keyOptions: [(key: ActivationKey, label: String)] = [
        (.fn, "fn"),
        (.ctrl, "ctrl"),
    ]

    var body: some View {
        VStack(spacing: VSpacing.xxl) {
            VStack(spacing: VSpacing.md) {
                Text("Let\u{2019}s find your voice.")
                    .font(VFont.onboardingTitle)
                    .foregroundColor(VColor.textPrimary)

                Text("To call \(state.assistantName), you\u{2019}ll hold down a key. Try pressing it now \u{2014} which of these lights up?")
                    .font(VFont.onboardingSubtitle)
                    .foregroundColor(VColor.textSecondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 400)
            }
            .opacity(showButtons ? 1 : 0)

            HStack(spacing: VSpacing.lg) {
                ForEach(keyOptions, id: \.key) { option in
                    keyButton(option.key, label: option.label)
                }
            }
            .opacity(showButtons ? 1 : 0)

            if let hint = wrongKeyHint {
                Text(hint)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
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
                .font(VFont.mono)
                .foregroundColor(highlightedKey == key ? .white : VColor.textPrimary.opacity(0.85))
                .frame(maxWidth: .infinity)
                .frame(height: 44)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .fill(highlightedKey == key ? VColor.accent : VColor.surface.opacity(0.5))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(highlightedKey == key ? Color.clear : VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
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
        VColor.background
        FnKeyStepView(state: {
            let s = OnboardingState()
            s.assistantName = "Alex"
            s.currentStep = 2
            return s
        }())
    }
    .frame(width: 520, height: 400)
}
