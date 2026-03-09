import VellumAssistantShared
import SwiftUI

enum DirectoryTab: String, CaseIterable {
    case threads = "Threads"
    case apps = "Apps"
    case documents = "Documents"

    var icon: String {
        switch self {
        case .threads: return "bubble.left.and.bubble.right"
        case .apps: return "square.grid.2x2"
        case .documents: return "doc.text"
        }
    }
}

struct DocumentItem: Identifiable {
    let id: String  // surfaceId
    let title: String
    let wordCount: Int
    let updatedAt: Date
}

struct DirectoryPanel: View {
    var onClose: () -> Void
    @ObservedObject var documentManager: DocumentManager
    @ObservedObject var threadManager: ThreadManager
    @ObservedObject var appListManager: AppListManager
    let daemonClient: DaemonClient
    @State private var selectedTab: DirectoryTab = .documents
    @State private var savedDocuments: [DocumentItem] = []
    @State private var isLoadingDocuments = false

    var body: some View {
        VSidePanel(title: "Directory", onClose: onClose, pinnedContent: { EmptyView() }) {
            VStack(spacing: 0) {
                // Tab bar
                HStack(spacing: VSpacing.xs) {
                    ForEach(DirectoryTab.allCases, id: \.self) { tab in
                        VTab(
                            label: tab.rawValue,
                            icon: tab.icon,
                            isSelected: selectedTab == tab,
                            isCloseable: false,
                            style: .pill,
                            onSelect: {
                                selectedTab = tab
                            }
                        )
                    }
                }
                .padding(.horizontal, VSpacing.lg)
                .padding(.bottom, VSpacing.md)

                Divider()
                    .background(VColor.surfaceBorder)

                // Tab content
                Group {
                    switch selectedTab {
                    case .threads:
                        threadsContent
                    case .apps:
                        appsContent
                    case .documents:
                        documentsContent
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    private var threadsContent: some View {
        VEmptyState(
            title: "No threads",
            subtitle: "Conversation threads will appear here",
            icon: "bubble.left.and.bubble.right"
        )
        .padding(VSpacing.xl)
    }

    private var appsContent: some View {
        Group {
            if appListManager.displayApps.isEmpty {
                VEmptyState(
                    title: "No apps",
                    subtitle: "Generated apps will appear here",
                    icon: VIcon.layoutGrid.rawValue
                )
                .padding(VSpacing.xl)
            } else {
                ScrollView {
                    VStack(spacing: VSpacing.sm) {
                        ForEach(appListManager.displayApps) { app in
                            appRow(app)
                        }
                    }
                    .padding(VSpacing.lg)
                }
            }
        }
    }

    private func appRow(_ app: AppListManager.AppItem) -> some View {
        Button(action: {
            // Open this app
            try? daemonClient.sendAppOpen(appId: app.id)
        }) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                HStack(spacing: VSpacing.sm) {
                    if let icon = app.icon {
                        Text(icon)
                            .font(.system(size: 24))
                    } else {
                        VIconView(.appWindow, size: 20)
                            .foregroundColor(VColor.textMuted)
                    }

                    VStack(alignment: .leading, spacing: 2) {
                        Text(app.name)
                            .font(VFont.bodyMedium)
                            .foregroundColor(VColor.textPrimary)
                            .lineLimit(1)

                        HStack(spacing: VSpacing.sm) {
                            if let appType = app.appType {
                                Text(appType)
                                    .font(VFont.caption)
                                    .foregroundColor(VColor.textSecondary)
                                Text("•")
                                    .font(VFont.caption)
                                    .foregroundColor(VColor.textMuted)
                            }

                            Text(relativeDateString(app.lastOpenedAt))
                                .font(VFont.caption)
                                .foregroundColor(VColor.textSecondary)
                        }
                    }

                    Spacer()

                    if app.isPinned {
                        VIconView(.pin, size: 12)
                            .foregroundColor(VColor.accent)
                    }
                }
            }
            .padding(VSpacing.md)
            .background(VColor.surface)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        }
        .buttonStyle(.plain)
    }

    private var documentsContent: some View {
        Group {
            if isLoadingDocuments {
                ProgressView("Loading documents...")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if savedDocuments.isEmpty {
                VEmptyState(
                    title: "No saved documents",
                    subtitle: "Documents you save will appear here",
                    icon: "doc.text"
                )
                .padding(VSpacing.xl)
            } else {
                ScrollView {
                    VStack(spacing: VSpacing.sm) {
                        ForEach(savedDocuments) { doc in
                            documentRow(doc)
                        }
                    }
                    .padding(VSpacing.lg)
                }
            }
        }
        .onAppear {
            loadDocuments()
        }
    }

    private func documentRow(_ doc: DocumentItem) -> some View {
        Button(action: {
            // Load and open this document
            try? daemonClient.sendDocumentLoad(surfaceId: doc.id)
        }) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text(doc.title)
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.textPrimary)
                    .lineLimit(1)

                HStack(spacing: VSpacing.sm) {
                    Text("\(doc.wordCount) words")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)

                    Text("•")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)

                    Text(relativeDateString(doc.updatedAt))
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(VSpacing.md)
            .background(VColor.surface)
            .cornerRadius(VRadius.md)
        }
        .buttonStyle(.plain)
    }

    private func relativeDateString(_ date: Date) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }

    private func loadDocuments() {
        isLoadingDocuments = true

        // Request document list from daemon
        daemonClient.onDocumentListResponse = { [self] response in
            Task { @MainActor in
                self.savedDocuments = response.documents.map { doc in
                    DocumentItem(
                        id: doc.surfaceId,
                        title: doc.title,
                        wordCount: doc.wordCount,
                        updatedAt: Date(timeIntervalSince1970: TimeInterval(doc.updatedAt) / 1000.0)
                    )
                }
                self.isLoadingDocuments = false
            }
        }

        try? daemonClient.sendDocumentList(conversationId: nil)  // nil = all documents
    }
}

#Preview {
    let documentManager = DocumentManager()
    let threadManager = ThreadManager(daemonClient: DaemonClient())
    let appListManager = AppListManager()
    let daemonClient = DaemonClient()

    return ZStack {
        VColor.background.ignoresSafeArea()
        DirectoryPanel(
            onClose: {},
            documentManager: documentManager,
            threadManager: threadManager,
            appListManager: appListManager,
            daemonClient: daemonClient
        )
        .frame(width: 400, height: 600)
    }
}
