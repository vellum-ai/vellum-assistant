import Combine
import Foundation

/// Cross-platform store for directory data operations (local apps, shared apps, documents).
///
/// Encapsulates all daemon communication for listing, opening, deleting, and sharing
/// apps and documents. Platform-specific UI (tabs, navigation, presentation) remains
/// in the platform view that delegates here.
@MainActor
public final class DirectoryStore: ObservableObject {

    // MARK: - Published State

    @Published public var localApps: [AppItem] = []
    @Published public var sharedApps: [SharedAppItem] = []
    @Published public var documents: [DocumentListItem] = []
    @Published public var isLoadingApps = false
    @Published public var isLoadingSharedApps = false
    @Published public var isLoadingDocuments = false

    // MARK: - Private State

    private let daemonClient: DaemonClient
    private var appFilesChangedTask: Task<Void, Never>?
    private var debounceTask: Task<Void, Never>?

    // MARK: - Init

    public init(daemonClient: DaemonClient) {
        self.daemonClient = daemonClient
        subscribeToAppFilesChanged()
    }

    deinit {
        appFilesChangedTask?.cancel()
        debounceTask?.cancel()
    }

    // MARK: - Local Apps

    /// Fetch the list of local apps from the daemon.
    public func fetchApps() {
        isLoadingApps = true

        Task {
            if let response = await AppClient().fetchList() {
                if response.success {
                    self.localApps = response.apps
                }
            }
            isLoadingApps = false
        }
    }

    /// Open a local app by ID.
    public func openApp(id: String) {
        Task { await AppClient().open(appId: id) }
    }

    /// Delete a local app by ID.
    public func deleteApp(id: String) {
        Task {
            if let response = await AppClient().delete(appId: id), response.success {
                fetchApps()
            }
        }
    }

    /// Share a local app to the cloud. Returns `true` on success.
    public func shareAppCloud(id: String) async -> Bool {
        let stream = daemonClient.subscribe()

        do {
            try daemonClient.sendShareAppCloud(appId: id)
        } catch {
            return false
        }

        let result = await stream.firstMatch { message -> Bool? in
            if case .shareAppCloudResponse(let response) = message {
                return response.success
            }
            return nil
        }
        return result ?? false
    }

    // MARK: - Shared Apps

    /// Fetch the list of shared apps from the daemon.
    public func fetchSharedApps() {
        isLoadingSharedApps = true

        Task {
            if let response = await AppClient().fetchSharedList() {
                self.sharedApps = response.apps
            }
            isLoadingSharedApps = false
        }
    }

    /// Delete a shared app by UUID.
    public func deleteSharedApp(uuid: String) {
        Task {
            if let response = await AppClient().deleteShared(uuid: uuid), response.success {
                fetchSharedApps()
            }
        }
    }

    /// Fork a shared app by UUID. Returns `true` on success.
    public func forkSharedApp(uuid: String) async -> Bool {
        let stream = daemonClient.subscribe()

        do {
            try daemonClient.sendForkSharedApp(uuid: uuid)
        } catch {
            return false
        }

        let result = await stream.firstMatch { message -> Bool? in
            if case .forkSharedAppResponse(let response) = message {
                return response.success
            }
            return nil
        }
        if result == true {
            fetchApps()
        }
        return result ?? false
    }

    /// Bundle a local app for sharing.
    public func bundleApp(id: String) {
        Task { await AppClient().bundle(appId: id) }
    }

    // MARK: - Documents

    /// Fetch the list of documents from the daemon.
    public func fetchDocuments(conversationId: String? = nil) {
        isLoadingDocuments = true

        Task {
            let stream = daemonClient.subscribe()

            do {
                try daemonClient.sendDocumentList(conversationId: conversationId)
            } catch {
                isLoadingDocuments = false
                return
            }

            let result = await stream.firstMatch { message -> [DocumentListItem]? in
                if case .documentListResponse(let response) = message {
                    return response.documents.map { doc in
                        DocumentListItem(
                            id: doc.surfaceId,
                            title: doc.title,
                            wordCount: doc.wordCount,
                            updatedAt: Date(timeIntervalSince1970: TimeInterval(doc.updatedAt) / 1000.0)
                        )
                    }
                }
                return nil
            }
            self.documents = result ?? self.documents
            isLoadingDocuments = false
        }
    }

    /// Load a specific document by surface ID.
    public func loadDocument(surfaceId: String) {
        Task {
            let stream = daemonClient.subscribe()

            do {
                try daemonClient.sendDocumentLoad(surfaceId: surfaceId)
            } catch {
                return
            }

            _ = await stream.firstMatch { message -> Bool? in
                if case .documentLoadResponse = message {
                    return true
                }
                return nil
            }
        }
    }

    // MARK: - Private

    /// Subscribe to appFilesChanged broadcasts with debounce, then refresh local apps.
    private func subscribeToAppFilesChanged() {
        appFilesChangedTask = Task { [weak self] in
            guard let daemonClient = self?.daemonClient else { return }
            let stream = daemonClient.subscribe()

            for await message in stream {
                guard let self, !Task.isCancelled else { return }
                if case .appFilesChanged = message {
                    self.debounceTask?.cancel()
                    self.debounceTask = Task { @MainActor [weak self] in
                        try? await Task.sleep(nanoseconds: 500_000_000)
                        guard !Task.isCancelled else { return }
                        self?.fetchApps()
                    }
                }
            }
        }
    }
}
