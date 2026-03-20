import Foundation

/// Shared store for simplified memory operations with search state.
/// Used by both macOS and iOS simplified memory views.
@MainActor
public final class SimplifiedMemoryStore: ObservableObject {
    @Published public var observations: [MemoryObservationPayload] = []
    @Published public var episodes: [MemoryEpisodePayload] = []
    @Published public var timeContexts: [MemoryTimeContextPayload] = []
    @Published public var openLoops: [MemoryOpenLoopPayload] = []
    @Published public var observationTotal: Int = 0
    @Published public var episodeTotal: Int = 0
    @Published public var isLoading = false
    @Published public var searchText: String = ""

    private let client: SimplifiedMemoryClientProtocol

    public init(client: SimplifiedMemoryClientProtocol) {
        self.client = client
    }

    /// Load all memory sections using the current search state.
    public func loadMemories() async {
        isLoading = true
        let response = await client.fetchMemories(
            search: searchText.isEmpty ? nil : searchText,
            limit: 100,
            offset: 0
        )
        if let response {
            observations = response.observations.items
            episodes = response.episodes.items
            timeContexts = response.timeContexts.items
            openLoops = response.openLoops.items
            observationTotal = response.observations.total
            episodeTotal = response.episodes.total
        }
        isLoading = false
    }

    /// Create a new observation and refresh the list on success.
    public func createObservation(content: String) async -> MemoryObservationPayload? {
        let observation = await client.createObservation(content: content)
        if observation != nil { await loadMemories() }
        return observation
    }

    /// Delete an observation and refresh the list on success.
    public func deleteObservation(id: String) async -> Bool {
        let success = await client.deleteObservation(id: id)
        if success { await loadMemories() }
        return success
    }
}
