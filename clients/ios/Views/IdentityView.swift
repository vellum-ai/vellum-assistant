#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

// MARK: - ViewModel

@MainActor @Observable
final class IdentityViewModel {
    var identity: RemoteIdentityInfo?
    var isLoading = false

    func fetchIdentity(client: any DaemonClientProtocol) async {
        guard let daemonClient = client as? DaemonClient else { return }
        isLoading = true
        identity = await daemonClient.fetchRemoteIdentity()
        isLoading = false
    }
}

// MARK: - View

struct IdentityView: View {
    @EnvironmentObject var clientProvider: ClientProvider
    @State private var viewModel = IdentityViewModel()

    var body: some View {
        NavigationStack {
            Group {
                if !clientProvider.isConnected {
                    disconnectedState
                } else if viewModel.isLoading && viewModel.identity == nil {
                    loadingState
                } else if let identity = viewModel.identity {
                    idCardContent(identity)
                } else {
                    noIdentityState
                }
            }
            .navigationTitle("Identity")
        }
        .task {
            if clientProvider.isConnected {
                await viewModel.fetchIdentity(client: clientProvider.client)
            }
        }
        .onChange(of: clientProvider.isConnected) { _, connected in
            if connected {
                Task {
                    await viewModel.fetchIdentity(client: clientProvider.client)
                }
            }
        }
    }

    // MARK: - ID Card Content

    private func idCardContent(_ identity: RemoteIdentityInfo) -> some View {
        ScrollView {
            VStack(spacing: VSpacing.lg) {
                avatarSection(identity)
                idCard(identity)
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.top, VSpacing.md)
        }
        .refreshable {
            await viewModel.fetchIdentity(client: clientProvider.client)
        }
    }

    private func avatarSection(_ identity: RemoteIdentityInfo) -> some View {
        VStack(spacing: VSpacing.sm) {
            Text(identity.emoji)
                .font(.system(size: 64))
                .accessibilityHidden(true)

            if !identity.name.isEmpty {
                Text(identity.name)
                    .font(VFont.title)
                    .foregroundColor(VColor.textPrimary)
            }

            if !identity.role.isEmpty {
                Text(identity.role)
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, VSpacing.lg)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Avatar: \(identity.name), \(identity.role)")
    }

    private func idCard(_ identity: RemoteIdentityInfo) -> some View {
        VStack(spacing: 0) {
            cardHeader

            VStack(spacing: 0) {
                if let assistantId = identity.assistantId, !assistantId.isEmpty {
                    idCardRow(label: "Assistant ID", value: assistantId)
                }

                if !identity.name.isEmpty {
                    idCardRow(label: "Name", value: identity.name)
                }

                if !identity.role.isEmpty {
                    idCardRow(label: "Role", value: identity.role)
                }

                if !identity.personality.isEmpty {
                    idCardRow(label: "Personality", value: identity.personality)
                }

                if let version = identity.version, !version.isEmpty {
                    idCardRow(label: "Version", value: version)
                }

                if let createdAt = identity.createdAt, !createdAt.isEmpty {
                    idCardRow(label: "Created", value: formatDate(createdAt))
                }

                if let originSystem = identity.originSystem, !originSystem.isEmpty {
                    idCardRow(label: "Origin", value: originSystem.capitalized)
                }

                if let home = identity.home, !home.isEmpty {
                    idCardRow(label: "Home", value: home, isLast: true)
                }
            }
        }
        .background(VColor.surface)
        .cornerRadius(VRadius.lg)
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.surfaceBorder, lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Identity card")
    }

    private var cardHeader: some View {
        HStack {
            Image(systemName: "person.text.rectangle")
                .foregroundColor(VColor.accent)
                .accessibilityHidden(true)
            Text("ID Card")
                .font(VFont.headline)
                .foregroundColor(VColor.textPrimary)
            Spacer()
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.md)
        .background(VColor.backgroundSubtle)
    }

    private func idCardRow(label: String, value: String, isLast: Bool = false) -> some View {
        VStack(spacing: 0) {
            HStack {
                Text(label)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                    .frame(width: 90, alignment: .leading)

                Text(value)
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)

                Spacer()
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.sm)

            if !isLast {
                Divider()
                    .padding(.leading, VSpacing.lg)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label): \(value)")
    }

    // MARK: - Empty States

    private var disconnectedState: some View {
        VStack(spacing: VSpacing.lg) {
            Image(systemName: "desktopcomputer")
                .font(.system(size: 48))
                .foregroundColor(VColor.textMuted)
                .accessibilityHidden(true)

            Text("Connect to Your Mac")
                .font(VFont.title)
                .foregroundColor(VColor.textPrimary)

            Text("Identity information is available when connected to your assistant on Mac.")
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, VSpacing.xl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var loadingState: some View {
        VStack(spacing: VSpacing.md) {
            ProgressView()
            Text("Loading identity...")
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var noIdentityState: some View {
        VStack(spacing: VSpacing.lg) {
            Image(systemName: "person.crop.circle.badge.questionmark")
                .font(.system(size: 48))
                .foregroundColor(VColor.textMuted)
                .accessibilityHidden(true)

            Text("No Identity Found")
                .font(VFont.title)
                .foregroundColor(VColor.textPrimary)

            Text("Your assistant doesn't have an IDENTITY.md file yet.")
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, VSpacing.xl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Helpers

    private func formatDate(_ isoString: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: isoString) {
            return formatDisplayDate(date)
        }
        // Try without fractional seconds
        formatter.formatOptions = [.withInternetDateTime]
        if let date = formatter.date(from: isoString) {
            return formatDisplayDate(date)
        }
        return isoString
    }

    private func formatDisplayDate(_ date: Date) -> String {
        let display = DateFormatter()
        display.dateStyle = .medium
        display.timeStyle = .none
        return display.string(from: date)
    }
}

#Preview {
    IdentityView()
        .environmentObject(ClientProvider(client: DaemonClient(config: .default)))
}
#endif
