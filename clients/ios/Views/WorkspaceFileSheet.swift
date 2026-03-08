#if canImport(UIKit)
import SwiftUI
import AVKit
import VellumAssistantShared

struct WorkspaceFileSheet: View {
    let filePath: String
    let mimeType: String?
    let client: DaemonClient?
    @Environment(\.dismiss) private var dismiss
    @State private var fileResponse: WorkspaceFileResponse?
    @State private var isLoading = true
    @State private var error: String?

    var displayName: String {
        let trimmed = filePath.hasSuffix("/") ? String(filePath.dropLast()) : filePath
        return trimmed.components(separatedBy: "/").last ?? filePath
    }

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
                        VIconView(.triangleAlert, size: 36)
                            .foregroundColor(VColor.textMuted)
                            .accessibilityHidden(true)
                        Text(error)
                            .font(VFont.body)
                            .foregroundColor(VColor.textSecondary)
                            .multilineTextAlignment(.center)
                    }
                    .padding(VSpacing.xl)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    contentView
                }
            }
            .navigationTitle(displayName)
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

    // MARK: - MIME-Aware Content Rendering

    @ViewBuilder
    private var contentView: some View {
        let resolvedMime = fileResponse?.mimeType ?? mimeType ?? ""

        if resolvedMime.hasPrefix("image/"), let contentURL = client?.workspaceFileContentURL(path: filePath) {
            ScrollView {
                AsyncImage(url: contentURL) { phase in
                    switch phase {
                    case .success(let image):
                        image
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                            .frame(maxWidth: .infinity)
                    case .failure:
                        VStack(spacing: VSpacing.md) {
                            VIconView(.image, size: 36)
                                .foregroundColor(VColor.textMuted)
                                .accessibilityHidden(true)
                            Text("Unable to load image")
                                .font(VFont.body)
                                .foregroundColor(VColor.textSecondary)
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    case .empty:
                        ProgressView()
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    @unknown default:
                        EmptyView()
                    }
                }
                .padding(VSpacing.lg)
            }
        } else if resolvedMime.hasPrefix("video/"), let contentURL = client?.workspaceFileContentURL(path: filePath) {
            VideoPlayer(player: AVPlayer(url: contentURL))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if resolvedMime.hasPrefix("text/") || resolvedMime == "application/json",
                  let content = fileResponse?.content {
            ScrollView {
                markdownContent(content)
                    .padding(VSpacing.lg)
            }
        } else if let content = fileResponse?.content, !content.isEmpty {
            // Fallback: if we got text content regardless of MIME type, show it
            ScrollView {
                markdownContent(content)
                    .padding(VSpacing.lg)
            }
        } else if let response = fileResponse {
            // Binary/unknown file — show metadata
            metadataView(response)
        } else {
            Text("No content")
                .font(VFont.body)
                .foregroundColor(VColor.textMuted)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func metadataView(_ response: WorkspaceFileResponse) -> some View {
        VStack(spacing: VSpacing.lg) {
            VIconView(.file, size: 48)
                .foregroundColor(VColor.textMuted)
                .accessibilityHidden(true)

            VStack(spacing: VSpacing.sm) {
                metadataRow(label: "Name", value: response.name)
                metadataRow(label: "Size", value: formatFileSize(response.size))
                metadataRow(label: "Type", value: response.mimeType)
                metadataRow(label: "Modified", value: formatDate(response.modifiedAt))
            }
            .padding(VSpacing.lg)
            .background(VColor.surface)
            .cornerRadius(VRadius.lg)
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .stroke(VColor.surfaceBorder, lineWidth: 1)
            )
        }
        .padding(VSpacing.xl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func metadataRow(label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
                .frame(width: 80, alignment: .leading)
            Text(value)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .lineLimit(2)
            Spacer()
        }
    }

    // MARK: - Markdown Rendering

    @ViewBuilder
    private func markdownContent(_ raw: String) -> some View {
        if let attributed = try? AttributedString(markdown: raw, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) {
            Text(attributed)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            Text(raw)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: - Loading

    private func loadContent() async {
        guard let client else {
            error = "Not connected to assistant."
            isLoading = false
            return
        }

        if let response = await client.fetchWorkspaceFile(path: filePath) {
            fileResponse = response
        } else {
            error = "Unable to read file."
        }
        isLoading = false
    }

    // MARK: - Helpers

    private func formatFileSize(_ bytes: Int) -> String {
        if bytes < 1024 { return "\(bytes) B" }
        let kb = Double(bytes) / 1024.0
        if kb < 1024 { return String(format: "%.1f KB", kb) }
        let mb = kb / 1024.0
        if mb < 1024 { return String(format: "%.1f MB", mb) }
        let gb = mb / 1024.0
        return String(format: "%.1f GB", gb)
    }

    private func formatDate(_ isoString: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: isoString) {
            return formatDisplayDate(date)
        }
        formatter.formatOptions = [.withInternetDateTime]
        if let date = formatter.date(from: isoString) {
            return formatDisplayDate(date)
        }
        return isoString
    }

    private func formatDisplayDate(_ date: Date) -> String {
        let display = DateFormatter()
        display.dateStyle = .medium
        display.timeStyle = .short
        return display.string(from: date)
    }
}
#endif
