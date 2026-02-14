import SwiftUI
import VellumAssistantShared

struct InputBarView: View {
    @Binding var text: String
    var isInputFocused: FocusState<Bool>.Binding
    let isGenerating: Bool
    let onSend: () -> Void

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
                .onSubmit {
                    if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        onSend()
                    }
                }
                .disabled(isGenerating)

            // Send button
            Button(action: onSend) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 32))
                    .foregroundColor(canSend ? VColor.accent : VColor.textMuted)
            }
            .disabled(!canSend)
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
                    onSend: { print("Send tapped") }
                )
            }
            .background(VColor.background)
        }
    }

    static var previews: some View {
        PreviewWrapper()
    }
}
