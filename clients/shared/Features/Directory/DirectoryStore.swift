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
            let stream = daemonClient.subscribe()

            do {
                try daemonClient.sendAppsList()
            } catch {
                isLoadingApps = false
                return
            }

            for await message in stream {
                if case .appsListResponse(let response) = message {
                    self.localApps = response.apps
                    self.isLoadingApps = false
                    return
                }
            }
            isLoadingApps = false
        }
    }

    /// Open a local app by ID.
    public func openApp(id: String) {
        try? daemonClient.sendAppOpen(appId: id)
    }

    /// Delete a local app by ID.
    public func deleteApp(id: String) {
        Task {
            let stream = daemonClient.subscribe()

            do {
                try daemonClient.sendAppDelete(appId: id)
            } catch {
                return
            }

            for await message in stream {
                if case .appDeleteResponse(let response) = message {
                    if response.success {
                        fetchApps()
                    }
                    return
                }
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

        // Race the stream listener against a 15-second timeout to avoid waiting
        // indefinitely when the transport returns early without emitting a response.
        return await withTaskGroup(of: Bool?.self) { group in
            group.addTask {
                for await message in stream {
                    if case .shareAppCloudResponse(let response) = message {
                        return response.success
                    }
                }
                return false
            }

            group.addTask {
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                return nil // sentinel indicating timeout
            }

            let first = await group.next() ?? nil

            // Cancel the remaining task (timeout or stream listener)
            group.cancelAll()

            return first ?? false
        }
    }

    // MARK: - Shared Apps

    /// Fetch the list of shared apps from the daemon.
    public func fetchSharedApps() {
        isLoadingSharedApps = true

        Task {
            let stream = daemonClient.subscribe()

            do {
                try daemonClient.sendSharedAppsList()
            } catch {
                isLoadingSharedApps = false
                return
            }

            for await message in stream {
                if case .sharedAppsListResponse(let response) = message {
                    self.sharedApps = response.apps
                    self.isLoadingSharedApps = false
                    return
                }
            }
            isLoadingSharedApps = false
        }
    }

    /// Delete a shared app by UUID.
    public func deleteSharedApp(uuid: String) {
        Task {
            let stream = daemonClient.subscribe()

            do {
                try daemonClient.sendSharedAppDelete(uuid: uuid)
            } catch {
                return
            }

            for await message in stream {
                if case .sharedAppDeleteResponse(let response) = message {
                    if response.success {
                        fetchSharedApps()
                    }
                    return
                }
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

        // Race the stream listener against a 15-second timeout to avoid waiting
        // indefinitely when the transport returns early without emitting a response.
        return await withTaskGroup(of: Bool?.self) { group in
            group.addTask {
                for await message in stream {
                    if case .forkSharedAppResponse(let response) = message {
                        return response.success
                    }
                }
                return false
            }

            group.addTask {
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                return nil // sentinel indicating timeout
            }

            let first = await group.next() ?? nil

            // Cancel the remaining task (timeout or stream listener)
            group.cancelAll()

            if let result = first {
                if result {
                    await MainActor.run { self.fetchApps() }
                }
                return result
            }
            return false // timeout
        }
    }

    /// Bundle a local app for sharing.
    public func bundleApp(id: String) {
        try? daemonClient.sendBundleApp(appId: id)
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

            for await message in stream {
                if case .documentListResponse(let response) = message {
                    self.documents = response.documents.map { doc in
                        DocumentListItem(
                            id: doc.surfaceId,
                            title: doc.title,
                            wordCount: doc.wordCount,
                            updatedAt: Date(timeIntervalSince1970: TimeInterval(doc.updatedAt) / 1000.0)
                        )
                    }
                    self.isLoadingDocuments = false
                    return
                }
            }
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

            for await message in stream {
                if case .documentLoadResponse = message {
                    return
                }
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
