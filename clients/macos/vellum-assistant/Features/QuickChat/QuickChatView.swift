import SwiftUI
import VellumAssistantShared

struct QuickChatView: View {
    let onSubmit: (String) -> Void
    let onDismiss: () -> Void

    @State private var text = ""
    @State private var isPresented = false
    @FocusState private var isFocused: Bool

    private let panelWidth: CGFloat = 400
    private let minEditorHeight: CGFloat = 36
    private let maxEditorHeight: CGFloat = 120

    var body: some View {
        VStack(spacing: 0) {
            TextEditor(text: $text)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .scrollContentBackground(.hidden)
                .padding(.horizontal, VSpacing.md)
                .padding(.vertical, VSpacing.sm)
                .frame(minHeight: minEditorHeight, maxHeight: maxEditorHeight)
                .fixedSize(horizontal: false, vertical: true)
                .focused($isFocused)
                .overlay(alignment: .topLeading) {
                    if text.isEmpty {
                        Text("Type a message...")
                            .font(VFont.body)
                            .foregroundColor(VColor.textMuted)
                            .padding(.horizontal, VSpacing.md + 5)
                            .padding(.vertical, VSpacing.sm + 1)
                            .allowsHitTesting(false)
                    }
                }
                .onKeyPress(.return) {
                    submit()
                    return .handled
                }
                .onKeyPress(.escape) {
                    onDismiss()
                    return .handled
                }
        }
        .frame(width: panelWidth)
        .background(
            VisualEffectBlur(material: .hudWindow, blendingMode: .behindWindow)
        )
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .scaleEffect(isPresented ? 1.0 : 0.95)
        .onAppear {
            isFocused = true
            withAnimation(VAnimation.fast) {
                isPresented = true
            }
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

// MARK: - Preview

#Preview("QuickChatView") {
    ZStack {
        Color.black.opacity(0.5).ignoresSafeArea()
        QuickChatView(
            onSubmit: { message in
                print("Submitted: \(message)")
            },
            onDismiss: {
                print("Dismissed")
            }
        )
    }
    .frame(width: 500, height: 300)
}
