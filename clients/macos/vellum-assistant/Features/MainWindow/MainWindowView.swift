import SwiftUI

struct MainWindowView: View {
    @State private var messages: [ChatMessage] = [
        ChatMessage(role: .assistant, text: "Hello! I'm \(UserDefaults.standard.string(forKey: "assistantName") ?? "vellum-assistant"). How can I help you today?"),
    ]
    @State private var inputText = ""
    @State private var isThinking = false

    var body: some View {
        ZStack {
            VColor.background
                .ignoresSafeArea()

            ChatView(
                messages: messages,
                inputText: $inputText,
                isThinking: isThinking,
                isSending: false,
                onSend: sendMessage
            )
        }
        .frame(minWidth: 800, minHeight: 600)
    }

    private func sendMessage() {
        let text = inputText.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return }

        messages.append(ChatMessage(role: .user, text: text))
        inputText = ""
        isThinking = true

        // Simulate an assistant reply for demo purposes
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            isThinking = false
            messages.append(ChatMessage(role: .assistant, text: "This is a placeholder response. Daemon integration coming soon."))
        }
    }
}

#Preview {
    MainWindowView()
}
