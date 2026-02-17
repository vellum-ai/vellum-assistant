#if canImport(UIKit)
import os
import SwiftUI
import VellumAssistantShared

private let log = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant",
    category: "InputBarView"
)

struct InputBarView: View {
    @Binding var text: String
    var isInputFocused: FocusState<Bool>.Binding
    let isGenerating: Bool
    let isCancelling: Bool
    let onSend: () -> Void
    let onStop: () -> Void

    var body: some View {
        HStack(spacing: VSpacing.md) {
            // Text field
            TextField("Message...", text: $text, axis: .vertical)
                .textFieldStyle(.plain)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .padding(VSpacing.md)
                .background(VColor.surface)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
                .focused(isInputFocused)

            // Stop button (shown while generating but not yet cancelling)
            if isGenerating && !isCancelling {
                Button(action: onStop) {
                    ZStack {
                        Circle()
                            .fill(VColor.textPrimary)
                            .frame(width: 32, height: 32)
                        RoundedRectangle(cornerRadius: 3)
                            .fill(VColor.background)
                            .frame(width: 11, height: 11)
                    }
                }
                .accessibilityLabel("Stop generation")
            } else {
                // Send button
                Button(action: onSend) {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 32))
                        .foregroundColor(canSend ? VColor.accent : VColor.textMuted)
                }
                .disabled(!canSend)
            }
        }
        .padding(VSpacing.md)
        .background(VColor.backgroundSubtle)
    }

    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isGenerating
    }
}

struct InputBarView_Previews: PreviewProvider {
    struct PreviewWrapper: View {
        @State private var text = "Hello world"
        @FocusState private var isFocused: Bool

        var body: some View {
            VStack {
                Spacer()
                InputBarView(
                    text: $text,
                    isInputFocused: $isFocused,
                    isGenerating: false,
                    isCancelling: false,
                    onSend: { log.debug("Send tapped") },
                    onStop: { log.debug("Stop tapped") }
                )
            }
            .background(VColor.background)
        }
    }

    static var previews: some View {
        PreviewWrapper()
    }
}
#endif
