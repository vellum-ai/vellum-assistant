import SwiftUI
import VellumAssistantShared

struct QuickInputView: View {
    let onSubmit: (String) -> Void
    let onDismiss: () -> Void

    @State private var text = ""
    @FocusState private var isFocused: Bool

    private let panelWidth: CGFloat = 500

    var body: some View {
        HStack(spacing: VSpacing.sm) {
            TextField("Send a message...", text: $text)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .textFieldStyle(.plain)
                .focused($isFocused)
                .onSubmit {
                    submit()
                }
                .onKeyPress(.escape) {
                    onDismiss()
                    return .handled
                }

            Button(action: submit) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 20))
                    .foregroundColor(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        ? VColor.textMuted
                        : VColor.sendButton)
            }
            .buttonStyle(.plain)
            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityLabel("Send message")
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.md)
        .frame(width: panelWidth)
        .background(
            VisualEffectBlur(material: .hudWindow, blendingMode: .behindWindow)
        )
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .onAppear {
            isFocused = true
        }
    }

    private func submit() {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        onSubmit(trimmed)
    }
}

// MARK: - NSVisualEffectView wrapper

struct VisualEffectBlur: NSViewRepresentable {
    let material: NSVisualEffectView.Material
    let blendingMode: NSVisualEffectView.BlendingMode

    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = material
        view.blendingMode = blendingMode
        view.state = .active
        return view
    }

    func updateNSView(_ nsView: NSVisualEffectView, context: Context) {
        nsView.material = material
        nsView.blendingMode = blendingMode
    }
}

#Preview("QuickInputView") {
    ZStack {
        Color.black.opacity(0.5).ignoresSafeArea()
        QuickInputView(
            onSubmit: { message in
                print("Submitted: \(message)")
            },
            onDismiss: {
                print("Dismissed")
            }
        )
    }
    .frame(width: 600, height: 200)
}
