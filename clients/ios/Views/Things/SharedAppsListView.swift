#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// List view of shared apps with detail sheet for fork/delete actions.
struct SharedAppsListView: View {
    @ObservedObject var directoryStore: DirectoryStore
    @State private var selectedApp: SharedAppItem?
    @State private var appToDelete: SharedAppItem?
    @State private var isForkingApp = false
    @State private var forkDismissTask: Task<Void, Never>?
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if directoryStore.isLoadingSharedApps && directoryStore.sharedApps.isEmpty {
                loadingView
            } else if directoryStore.sharedApps.isEmpty {
                emptyView
            } else {
                listContent
            }
        }
        .sheet(item: $selectedApp) { app in
            sharedAppDetail(app)
        }
        .alert("Delete Shared App", isPresented: Binding(
            get: { appToDelete != nil },
            set: { if !$0 { appToDelete = nil } }
        )) {
            Button("Cancel", role: .cancel) { appToDelete = nil }
            Button("Delete", role: .destructive) {
                if let app = appToDelete {
                    directoryStore.deleteSharedApp(uuid: app.uuid)
                    appToDelete = nil
                    selectedApp = nil
                }
            }
        } message: {
            if let app = appToDelete {
                Text("Are you sure you want to delete \"\(app.name)\"? This action cannot be undone.")
            }
        }
    }

    // MARK: - List Content

    private var listContent: some View {
        List(directoryStore.sharedApps, id: \.uuid) { app in
            Button {
                selectedApp = app
            } label: {
                sharedAppRow(app)
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                Button(role: .destructive) {
                    appToDelete = app
                } label: {
                    Label { Text("Delete") } icon: { VIconView(.trash, size: 14) }
                }
            }
        }
        .listStyle(.plain)
        .refreshable {
            directoryStore.fetchSharedApps()
            while directoryStore.isLoadingSharedApps {
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
        }
    }

    // MARK: - Row

    private func sharedAppRow(_ app: SharedAppItem) -> some View {
        HStack(spacing: VSpacing.md) {
            Text(app.icon ?? "\u{1F4E6}")
                .font(.system(size: 28))

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: VSpacing.xs) {
                    Text(app.name)
                        .font(VFont.bodyBold)
                        .foregroundColor(VColor.contentDefault)
                        .lineLimit(1)

                    if app.updateAvailable == true {
                        Text("Update")
                            .font(VFont.caption)
                            .foregroundColor(VColor.primaryBase)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(VColor.primaryBase.opacity(0.15))
                            .cornerRadius(4)
                    }
                }

                if let signer = app.signerDisplayName {
                    HStack(spacing: VSpacing.xs) {
                        Text(signer)
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentSecondary)
                        trustBadge(app.trustTier)
                    }
                }
            }

            Spacer()

            VIconView(.chevronRight, size: 14)
                .foregroundColor(VColor.contentTertiary)
        }
        .padding(.vertical, VSpacing.xs)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(app.name)\(app.signerDisplayName != nil ? " by \(app.signerDisplayName!)" : ""), trust: \(app.trustTier)\(app.updateAvailable == true ? ", update available" : "")")
        .accessibilityHint("Opens shared app details")
    }

    // MARK: - Trust Badge

    private func trustBadge(_ tier: String) -> some View {
        Text(tier.capitalized)
            .font(VFont.caption)
            .foregroundColor(trustColor(tier))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(trustColor(tier).opacity(0.15))
            .cornerRadius(4)
    }

    private func trustColor(_ tier: String) -> Color {
        switch tier.lowercased() {
        case "trusted": return .green
        case "verified": return .blue
        case "community": return .orange
        default: return VColor.contentTertiary
        }
    }

    // MARK: - Detail Sheet

    private func sharedAppDetail(_ app: SharedAppItem) -> some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        Text(app.icon ?? "\u{1F4E6}")
                            .font(.system(size: 48))
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text(app.name)
                                .font(VFont.title)
                                .foregroundColor(VColor.contentDefault)
                            if let signer = app.signerDisplayName {
                                Text("by \(signer)")
                                    .font(VFont.caption)
                                    .foregroundColor(VColor.contentSecondary)
                            }
                        }
                    }
                }

                if let description = app.description {
                    Section("Description") {
                        Text(description)
                            .font(VFont.body)
                            .foregroundColor(VColor.contentDefault)
                    }
                }

                Section("Details") {
                    LabeledContent("Trust Tier") {
                        trustBadge(app.trustTier)
                    }
                    LabeledContent("Bundle Size") {
                        Text(formattedSize(app.bundleSizeBytes))
                            .foregroundColor(VColor.contentSecondary)
                    }
                    LabeledContent("Installed") {
                        Text(app.installedAt)
                            .foregroundColor(VColor.contentSecondary)
                    }
                    if let version = app.version {
                        LabeledContent("Version") {
                            Text(version)
                                .foregroundColor(VColor.contentSecondary)
                        }
                    }
                }

                Section {
                    Button {
                        isForkingApp = true
                        forkDismissTask?.cancel()
                        forkDismissTask = Task { @MainActor in
                            let success = await directoryStore.forkSharedApp(uuid: app.uuid)
                            guard !Task.isCancelled else { return }
                            isForkingApp = false
                            if success {
                                selectedApp = nil
                            } else {
                                errorMessage = "Failed to fork app. Please try again."
                            }
                        }
                    } label: {
                        HStack {
                            Label { Text("Fork App") } icon: { VIconView(.gitBranch, size: 14) }
                            Spacer()
                            if isForkingApp {
                                ProgressView()
                            }
                        }
                    }
                    .disabled(isForkingApp)

                    Button(role: .destructive) {
                        appToDelete = app
                    } label: {
                        Label { Text("Delete App") } icon: { VIconView(.trash, size: 14) }
                    }
                    .disabled(isForkingApp)
                }
            }
            .navigationTitle("Shared App")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { selectedApp = nil }
                        .disabled(isForkingApp)
                }
            }
            .overlay {
                if isForkingApp {
                    Color.black.opacity(0.05)
                        .ignoresSafeArea()
                        .allowsHitTesting(false)
                }
            }
            .onDisappear {
                forkDismissTask?.cancel()
                forkDismissTask = nil
                isForkingApp = false
            }
            .alert("Error", isPresented: Binding(
                get: { errorMessage != nil },
                set: { if !$0 { errorMessage = nil } }
            )) {
                Button("OK", role: .cancel) { errorMessage = nil }
            } message: {
                if let msg = errorMessage {
                    Text(msg)
                }
            }
        }
    }

    // MARK: - States

    private var loadingView: some View {
        VStack(spacing: VSpacing.md) {
            ProgressView()
            Text("Loading shared apps...")
                .font(VFont.body)
                .foregroundColor(VColor.contentSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var emptyView: some View {
        VStack(spacing: VSpacing.md) {
            VIconView(.package, size: 48)
                .foregroundColor(VColor.contentTertiary)
                .accessibilityHidden(true)
            Text("No shared apps")
                .font(VFont.body)
                .foregroundColor(VColor.contentSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("No shared apps")
    }

    // MARK: - Helpers

    private func formattedSize(_ bytes: Int) -> String {
        let formatter = ByteCountFormatter()
        formatter.countStyle = .file
        return formatter.string(fromByteCount: Int64(bytes))
    }
}

// MARK: - SharedAppItem Identifiable conformance for .sheet(item:)
// The Identifiable conformance via uuid is already declared in MessageTypes.swift

#endif
