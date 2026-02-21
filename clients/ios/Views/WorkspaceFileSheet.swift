#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct WorkspaceFileSheet: View {
    let file: WorkspaceFileInfo
    let client: DaemonClient?
    @Environment(\.dismiss) private var dismiss
    @State private var content: String?
    @State private var isLoading = true
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    VStack(spacing: VSpacing.md) {
                        ProgressView()
                        Text("Loading file...")
                            .font(VFont.body)
                            .foregroundColor(VColor.textSecondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let error {
                    VStack(spacing: VSpacing.md) {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.system(size: 36))
                            .foregroundColor(VColor.textMuted)
                            .accessibilityHidden(true)
                        Text(error)
                            .font(VFont.body)
                            .foregroundColor(VColor.textSecondary)
                            .multilineTextAlignment(.center)
                    }
                    .padding(VSpacing.xl)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let content {
                    ScrollView {
                        markdownContent(content)
                            .padding(VSpacing.lg)
                    }
                } else {
                    Text("No content")
                        .font(VFont.body)
                        .foregroundColor(VColor.textMuted)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .navigationTitle(file.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .task {
            await loadContent()
        }
    }

    @ViewBuilder
    private func markdownContent(_ raw: String) -> some View {
        if let attributed = try? AttributedString(markdown: raw, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) {
            Text(attributed)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            // Fallback to plain text
            Text(raw)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func loadContent() async {
        guard let client else {
            error = "Not connected to daemon."
            isLoading = false
            return
        }

        let stream = client.subscribe()
        do {
            try client.sendWorkspaceFileRead(path: file.path)
        } catch {
            self.error = "Failed to request file."
            isLoading = false
            return
        }

        for await message in stream {
            if case .workspaceFileReadResponse(let response) = message, response.path == file.path {
                if let fileContent = response.content {
                    content = fileContent
                } else {
                    self.error = response.error ?? "Unable to read file."
                }
                isLoading = false
                return
            }
        }

        error = "Connection lost."
        isLoading = false
    }
}
#endif
