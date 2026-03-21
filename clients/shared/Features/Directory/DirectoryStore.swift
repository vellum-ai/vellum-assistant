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

    private let appsClient: AppsClientProtocol
    private let documentClient: DocumentClientProtocol
    /// Daemon client retained for push event subscriptions (appFilesChanged)
    /// which use message transport.
    private weak var connectionManager: GatewayConnectionManager?
    private let eventStreamClient: EventStreamClient?
    private var appFilesChangedTask: Task<Void, Never>?
    private var debounceTask: Task<Void, Never>?
    private var reconnectObserver: NSObjectProtocol?

    // MARK: - Init

    public init(connectionManager: GatewayConnectionManager, eventStreamClient: EventStreamClient, documentClient: DocumentClientProtocol = DocumentClient()) {
        self.appsClient = AppsClient()
        self.documentClient = documentClient
        self.connectionManager = connectionManager
        self.eventStreamClient = eventStreamClient
        subscribeToAppFilesChanged()
        reconnectObserver = NotificationCenter.default.addObserver(
            forName: .daemonDidReconnect,
            object: nil,
            queue: nil
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.subscribeToAppFilesChanged()
            }
        }
    }

    deinit {
        appFilesChangedTask?.cancel()
        debounceTask?.cancel()
        if let reconnectObserver {
            NotificationCenter.default.removeObserver(reconnectObserver)
        }
    }

    // MARK: - Local Apps

    /// Fetch the list of local apps from the daemon.
    public func fetchApps() {
        isLoadingApps = true

        Task {
            let response = await appsClient.fetchAppsList()
            if let response, response.success {
                self.localApps = response.apps
            }
            isLoadingApps = false
        }
    }

    /// Open a local app by ID (fire-and-forget).
    public func openApp(id: String) {
        guard let connectionManager, let eventStreamClient else { return }
        Task { await AppsClient.openAppAndDispatchSurface(id: id, connectionManager: connectionManager, eventStreamClient: eventStreamClient) }
    }

    /// Open a local app by ID, returning the result for callers that need to
    /// dispatch a surface show event.
    @discardableResult
    public func openAppAsync(id: String) async -> AppOpenResult? {
        await appsClient.openApp(id: id)
    }

    /// Delete a local app by ID.
    public func deleteApp(id: String) {
        Task {
            let response = await appsClient.deleteApp(id: id)
            if response?.success == true {
                fetchApps()
            }
        }
    }

    /// Share a local app to the cloud. Returns `true` on success.
    public func shareAppCloud(id: String) async -> Bool {
        let response = await appsClient.shareAppCloud(appId: id)
        return response?.success ?? false
    }

    // MARK: - Shared Apps

    /// Fetch the list of shared apps from the daemon.
    public func fetchSharedApps() {
        isLoadingSharedApps = true

        Task {
            let response = await appsClient.fetchSharedAppsList()
            if let response {
                if !response.apps.isEmpty || self.sharedApps.isEmpty {
                    self.sharedApps = response.apps
                }
            }
            isLoadingSharedApps = false
        }
    }

    /// Delete a shared app by UUID.
    public func deleteSharedApp(uuid: String) {
        Task {
            let response = await appsClient.deleteSharedApp(uuid: uuid)
            if response?.success == true {
                fetchSharedApps()
            }
        }
    }

    /// Fork a shared app by UUID. Returns `true` on success.
    public func forkSharedApp(uuid: String) async -> Bool {
        let response = await appsClient.forkSharedApp(uuid: uuid)
        let success = response?.success ?? false
        if success {
            fetchApps()
        }
        return success
    }

    /// Bundle a local app for sharing.
    public func bundleApp(id: String) {
        Task { _ = await appsClient.bundleApp(appId: id) }
    }

    // MARK: - Documents

    /// Fetch the list of documents via the gateway.
    public func fetchDocuments(conversationId: String? = nil) {
        isLoadingDocuments = true

        Task {
            let response = await documentClient.fetchList(conversationId: conversationId)
            if let response {
                self.documents = response.documents.map { doc in
                    DocumentListItem(
                        id: doc.surfaceId,
                        title: doc.title,
                        wordCount: doc.wordCount,
                        updatedAt: Date(timeIntervalSince1970: TimeInterval(doc.updatedAt) / 1000.0)
                    )
                }
            }
            isLoadingDocuments = false
        }
    }

    /// Load a specific document by surface ID.
    public func loadDocument(surfaceId: String) {
        Task {
            _ = await documentClient.fetchDocument(surfaceId: surfaceId)
        }
    }

    // MARK: - Private

    /// Subscribe to appFilesChanged broadcasts with debounce, then refresh local apps.
    private func subscribeToAppFilesChanged() {
        appFilesChangedTask?.cancel()
        appFilesChangedTask = Task { [weak self] in
            guard let eventStreamClient = self?.eventStreamClient else { return }
            let stream = eventStreamClient.subscribe()

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
