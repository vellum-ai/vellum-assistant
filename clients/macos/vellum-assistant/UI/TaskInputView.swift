import SwiftUI
import AppKit

struct TaskInputView: View {
    let onSubmit: (String) -> Void
    @State private var taskText = ""
    @FocusState private var isTextFieldFocused: Bool
    @Environment(\.openSettings) private var openSettings

    private var hasAPIKey: Bool {
        APIKeyManager.getKey() != nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("vellum-assistant")
                    .font(.headline)
                    .foregroundStyle(.primary)
                Spacer()
                Button(action: {
                    // LSUIElement apps need to become regular apps temporarily to take focus
                    NSApp.setActivationPolicy(.regular)
                    openSettings()
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                        NSApp.activate(ignoringOtherApps: true)
                    }
                }) {
                    Image(systemName: "gear")
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
            }

            TextEditor(text: $taskText)
                .font(.body)
                .frame(minHeight: 60, maxHeight: 100)
                .scrollContentBackground(.hidden)
                .padding(8)
                .background(Color(.textBackgroundColor))
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .focused($isTextFieldFocused)

            if !hasAPIKey {
                Text("No API key configured. Open Settings to add one.")
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            HStack {
                Spacer()
                Button("Go") {
                    submitTask()
                }
                .keyboardShortcut(.return, modifiers: [])
                .disabled(taskText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !hasAPIKey)
                .buttonStyle(.borderedProminent)
            }
        }
        .padding()
        .frame(width: 320)
        .onAppear {
            isTextFieldFocused = true
        }
    }

    private func submitTask() {
        let trimmed = taskText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        taskText = ""
        onSubmit(trimmed)
    }
}
