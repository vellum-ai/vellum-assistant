import SwiftUI
import VellumAssistantShared

// MARK: - Models

struct SlackChannel: Codable, Identifiable {
    let id: String
    let name: String
    let type: String
    let isPrivate: Bool

    enum CodingKeys: String, CodingKey {
        case id, name, type
        case isPrivate = "is_private"
    }
}

private struct SlackChannelsResponse: Codable {
    let channels: [SlackChannel]
}

// MARK: - View

struct SlackChannelPickerView: View {
    let gatewayBaseURL: String
    let onSelect: (SlackChannel) -> Void
    let onCancel: () -> Void

    @State private var channels: [SlackChannel] = []
    @State private var searchText = ""
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var hoveredChannelID: String?

    private var filteredChannels: [SlackChannel] {
        if searchText.isEmpty { return channels }
        let query = searchText.lowercased()
        return channels.filter { $0.name.lowercased().contains(query) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
                .padding(VSpacing.lg)

            VColor.borderBase.frame(height: 1)

            VSearchBar(placeholder: "Search channels...", text: $searchText)
                .padding(.horizontal, VSpacing.md)
                .padding(.vertical, VSpacing.sm)

            VColor.borderBase.frame(height: 1)

            if isLoading {
                loadingState
            } else if let errorMessage {
                errorState(errorMessage)
            } else if filteredChannels.isEmpty {
                emptyState
            } else {
                channelList
            }
        }
        .frame(width: 240)
        .onDisappear {
            hoveredChannelID = nil
        }
        .task {
            await loadChannels()
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: VSpacing.sm) {
            Button(action: onCancel) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(VColor.contentSecondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Back")

            Text("Send to Slack")
                .font(VFont.headline)
                .foregroundColor(VColor.contentDefault)

            Spacer()
        }
    }

    // MARK: - Loading

    private var loadingState: some View {
        VStack(spacing: VSpacing.sm) {
            ProgressView()
                .controlSize(.small)
            Text("Loading channels...")
                .font(VFont.caption)
                .foregroundColor(VColor.contentTertiary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, VSpacing.xxl)
    }

    // MARK: - Error

    private func errorState(_ message: String) -> some View {
        VStack(spacing: VSpacing.sm) {
            Text(message)
                .font(VFont.caption)
                .foregroundColor(VColor.systemNegativeStrong)
                .multilineTextAlignment(.center)

            Button("Retry") {
                Task { await loadChannels() }
            }
            .buttonStyle(.plain)
            .font(VFont.captionMedium)
            .foregroundColor(VColor.primaryBase)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, VSpacing.xxl)
    }

    // MARK: - Empty

    private var emptyState: some View {
        Text(searchText.isEmpty ? "No channels found" : "No matching channels")
            .font(VFont.caption)
            .foregroundColor(VColor.contentTertiary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, VSpacing.xxl)
    }

    // MARK: - Channel List

    private var channelList: some View {
        ScrollView {
            VStack(spacing: 0) {
                ForEach(filteredChannels) { channel in
                    channelRow(channel)
                }
            }
            .padding(.vertical, VSpacing.xs)
        }
        .frame(maxHeight: 300)
    }

    private func channelRow(_ channel: SlackChannel) -> some View {
        Button {
            onSelect(channel)
        } label: {
            HStack(spacing: VSpacing.sm) {
                Image(systemName: iconName(for: channel))
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(VColor.contentSecondary)
                    .frame(width: 18, height: 18)

                Text(channel.name)
                    .font(VFont.body)
                    .foregroundColor(VColor.contentDefault)
                    .lineLimit(1)

                Spacer()
            }
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.sm)
            .background(VColor.surfaceBase.opacity(hoveredChannelID == channel.id ? 1 : 0))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            hoveredChannelID = hovering ? channel.id : nil
        }
        .pointerCursor()
    }

    // MARK: - Helpers

    private func iconName(for channel: SlackChannel) -> String {
        if channel.isPrivate {
            return "lock"
        }
        switch channel.type {
        case "dm", "mpim":
            return "person"
        default:
            return "number"
        }
    }

    private func loadChannels() async {
        isLoading = true
        errorMessage = nil

        defer { isLoading = false }

        guard let url = URL(string: "\(gatewayBaseURL)/v1/slack/channels") else {
            errorMessage = "Invalid gateway URL"
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"

        if let token = ActorTokenManager.getToken(), !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let httpResponse = response as? HTTPURLResponse else {
                errorMessage = "Unexpected response"
                return
            }

            guard (200...299).contains(httpResponse.statusCode) else {
                errorMessage = "Failed to load channels (\(httpResponse.statusCode))"
                return
            }

            let decoded = try JSONDecoder().decode(SlackChannelsResponse.self, from: data)
            channels = decoded.channels
        } catch is CancellationError {
            // Task cancelled, no error to show
        } catch {
            errorMessage = "Failed to load channels"
        }
    }
}
