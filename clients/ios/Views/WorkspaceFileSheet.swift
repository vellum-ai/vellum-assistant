#if canImport(UIKit)
import SwiftUI
import AVKit
import VellumAssistantShared

struct WorkspaceFileSheet: View {
    let filePath: String
    let mimeType: String?
    let client: DaemonClient?
    let workspaceClient: WorkspaceClient
    @Environment(\.dismiss) private var dismiss
    @State private var fileResponse: WorkspaceFileResponse?
    @State private var isLoading = true
    @State private var error: String?
    @State private var editableContent: String = ""
    @State private var originalContent: String = ""
    @State private var isDirty = false
    @State private var isSaving = false

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
                            .foregroundColor(VColor.contentSecondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let error {
                    VStack(spacing: VSpacing.md) {
                        VIconView(.triangleAlert, size: 36)
                            .foregroundColor(VColor.contentTertiary)
                            .accessibilityHidden(true)
                        Text(error)
                            .font(VFont.body)
                            .foregroundColor(VColor.contentSecondary)
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
                ToolbarItem(placement: .confirmationAction) {
                    if isDirty {
                        Button("Save") {
                            Task { await saveFile() }
                        }
                        .disabled(isSaving)
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .task {
            await loadContent()
            if let content = fileResponse?.content {
                editableContent = content
                originalContent = content
            }
        }
    }

    // MARK: - MIME-Aware Content Rendering

    @ViewBuilder
    private var contentView: some View {
        let resolvedMime = fileResponse?.mimeType ?? mimeType ?? ""

        if resolvedMime.hasPrefix("image/"), let contentURL = workspaceClient.workspaceFileContentURL(path: filePath, showHidden: false) {
            AuthenticatedImageView(url: contentURL, client: client)
        } else if resolvedMime.hasPrefix("video/"), let contentURL = workspaceClient.workspaceFileContentURL(path: filePath, showHidden: false) {
            WorkspaceVideoPlayer(url: contentURL, client: client)
        } else if let response = fileResponse, !response.isBinary, response.content != nil {
            TextEditor(text: $editableContent)
                .font(VFont.mono)
                .padding(VSpacing.sm)
                .onChange(of: editableContent) { _, newValue in
                    isDirty = newValue != originalContent
                }
        } else if let response = fileResponse {
            metadataView(response)
        } else {
            Text("No content")
                .font(VFont.body)
                .foregroundColor(VColor.contentTertiary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func metadataView(_ response: WorkspaceFileResponse) -> some View {
        VStack(spacing: VSpacing.lg) {
            VIconView(.file, size: 48)
                .foregroundColor(VColor.contentTertiary)
                .accessibilityHidden(true)

            VStack(spacing: VSpacing.sm) {
                metadataRow(label: "Name", value: response.name)
                metadataRow(label: "Size", value: formatFileSize(response.size))
                metadataRow(label: "Type", value: response.mimeType)
                metadataRow(label: "Modified", value: formatDate(response.modifiedAt))
            }
            .padding(VSpacing.lg)
            .background(VColor.surfaceBase)
            .cornerRadius(VRadius.lg)
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .stroke(VColor.borderBase, lineWidth: 1)
            )
        }
        .padding(VSpacing.xl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func metadataRow(label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(VFont.caption)
                .foregroundColor(VColor.contentTertiary)
                .frame(width: 80, alignment: .leading)
            Text(value)
                .font(VFont.body)
                .foregroundColor(VColor.contentDefault)
                .lineLimit(2)
            Spacer()
        }
    }

    // MARK: - Loading

    private func loadContent() async {
        if let response = await workspaceClient.fetchWorkspaceFile(path: filePath, showHidden: false) {
            fileResponse = response
        } else {
            error = "Unable to read file."
        }
        isLoading = false
    }

    private func saveFile() async {
        guard let path = fileResponse?.path else { return }
        isSaving = true
        let snapshot = editableContent
        let data = Data(snapshot.utf8)
        let success = await workspaceClient.writeWorkspaceFile(path: path, content: data)
        if success {
            originalContent = snapshot
            isDirty = editableContent != snapshot
        }
        isSaving = false
    }

    // MARK: - Helpers

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

// MARK: - Authenticated Image View

private struct AuthenticatedImageView: View {
    let url: URL
    let client: DaemonClient?
    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        Group {
            if let image {
                ScrollView {
                    Image(uiImage: image)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(maxWidth: .infinity)
                        .padding(VSpacing.lg)
                }
            } else if failed {
                VStack(spacing: VSpacing.md) {
                    VIconView(.image, size: 36)
                        .foregroundColor(VColor.contentTertiary)
                        .accessibilityHidden(true)
                    Text("Unable to load image")
                        .font(VFont.body)
                        .foregroundColor(VColor.contentSecondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: url) {
            failed = false
            image = nil
            await loadImage()
        }
    }

    private func loadImage() async {
        var request = URLRequest(url: url)
        if let token = ActorTokenManager.getToken(), !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                failed = true
                return
            }
            // 401 retry: re-bootstrap actor token via GuardianClient then retry once
            if http.statusCode == 401 {
                guard let client,
                      let platform = client.recoveryPlatform,
                      let deviceId = client.recoveryDeviceId else {
                    failed = true
                    return
                }
                let success = await GuardianClient().bootstrapActorToken(
                    platform: platform,
                    deviceId: deviceId
                )
                guard success else {
                    failed = true
                    return
                }
                var retryRequest = URLRequest(url: url)
                if let freshToken = ActorTokenManager.getToken(), !freshToken.isEmpty {
                    retryRequest.setValue("Bearer \(freshToken)", forHTTPHeaderField: "Authorization")
                }
                let (retryData, retryResponse) = try await URLSession.shared.data(for: retryRequest)
                guard let retryHttp = retryResponse as? HTTPURLResponse, (200...299).contains(retryHttp.statusCode) else {
                    failed = true
                    return
                }
                image = UIImage(data: retryData)
                if image == nil { failed = true }
                return
            }
            guard (200...299).contains(http.statusCode) else {
                failed = true
                return
            }
            image = UIImage(data: data)
            if image == nil { failed = true }
        } catch {
            failed = true
        }
    }
}

// MARK: - Authenticated Video Player

private struct WorkspaceVideoPlayer: View {
    let url: URL
    let client: DaemonClient?
    @State private var player: AVPlayer?
    @State private var tempFileURL: URL?
    @State private var failed = false

    var body: some View {
        Group {
            if let player {
                VideoPlayer(player: player)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if failed {
                VStack(spacing: VSpacing.md) {
                    VIconView(.triangleAlert, size: 36)
                        .foregroundColor(VColor.contentTertiary)
                        .accessibilityHidden(true)
                    Text("Unable to load video")
                        .font(VFont.body)
                        .foregroundColor(VColor.contentSecondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: url) {
            failed = false
            player?.pause()
            player = nil
            cleanupTempFile()
            await loadVideo()
        }
        .onDisappear {
            player?.pause()
            player = nil
            cleanupTempFile()
        }
    }

    private func loadVideo() async {
        var request = URLRequest(url: url)
        if let token = ActorTokenManager.getToken(), !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        do {
            let (localURL, response) = try await URLSession.shared.download(for: request)
            guard let http = response as? HTTPURLResponse else {
                failed = true
                return
            }
            // 401 retry: re-bootstrap actor token via GuardianClient then retry once
            if http.statusCode == 401 {
                try? FileManager.default.removeItem(at: localURL)
                guard let client,
                      let platform = client.recoveryPlatform,
                      let deviceId = client.recoveryDeviceId else {
                    failed = true
                    return
                }
                let success = await GuardianClient().bootstrapActorToken(
                    platform: platform,
                    deviceId: deviceId
                )
                guard success else {
                    failed = true
                    return
                }
                var retryRequest = URLRequest(url: url)
                if let freshToken = ActorTokenManager.getToken(), !freshToken.isEmpty {
                    retryRequest.setValue("Bearer \(freshToken)", forHTTPHeaderField: "Authorization")
                }
                let (retryLocalURL, retryResponse) = try await URLSession.shared.download(for: retryRequest)
                guard let retryHttp = retryResponse as? HTTPURLResponse, (200...299).contains(retryHttp.statusCode) else {
                    try? FileManager.default.removeItem(at: retryLocalURL)
                    failed = true
                    return
                }
                let tmpFile = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".mp4")
                try FileManager.default.moveItem(at: retryLocalURL, to: tmpFile)
                tempFileURL = tmpFile
                player = AVPlayer(url: tmpFile)
                return
            }
            guard (200...299).contains(http.statusCode) else {
                try? FileManager.default.removeItem(at: localURL)
                failed = true
                return
            }
            let tmpFile = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".mp4")
            try FileManager.default.moveItem(at: localURL, to: tmpFile)
            tempFileURL = tmpFile
            player = AVPlayer(url: tmpFile)
        } catch {
            failed = true
        }
    }

    private func cleanupTempFile() {
        if let tempFileURL {
            try? FileManager.default.removeItem(at: tempFileURL)
        }
        tempFileURL = nil
    }
}
#endif
