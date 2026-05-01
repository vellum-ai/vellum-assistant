import Foundation
import Observation
import os
import VellumAssistantShared

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "CallSiteCatalog")

/// A domain grouping for LLM call sites, fetched from the API catalog.
/// Replaces the former `CallSiteDomain` enum — domain metadata now lives
/// in the assistant runtime and is fetched once on sheet open.
public struct CallSiteDomain: Identifiable, Hashable {
    public let id: String
    public let displayName: String

    public init(id: String, displayName: String) {
        self.id = id
        self.displayName = displayName
    }
}

/// A user-editable override entry for a single LLM call site.
///
/// Mirrors the wire shape of `llm.callSites.<id>` in the assistant config:
/// any combination of `provider`, `model`, and `profile` may be set; an
/// entry where all three are `nil` represents "follows the default".
/// Display metadata (displayName, callSiteDescription, domain) comes from
/// the API catalog fetched by `CallSiteCatalog`.
public struct CallSiteOverride: Identifiable, Equatable, Hashable {
    /// Stable call-site identifier matching the backend `LLMCallSiteEnum`.
    public let id: String

    /// User-facing label shown in the override picker.
    public let displayName: String

    /// Short one-line description of what this call site does.
    public let callSiteDescription: String

    /// Domain ID matching a `CallSiteDomain.id` from the API catalog.
    public let domain: String

    /// Provider override; `nil` means "follows the default".
    public var provider: String?

    /// Model override; `nil` means "follows the default".
    public var model: String?

    /// Profile override referencing a key in `llm.profiles`; `nil` means
    /// "no profile selected".
    public var profile: String?

    public init(
        id: String,
        displayName: String,
        callSiteDescription: String = "",
        domain: String,
        provider: String? = nil,
        model: String? = nil,
        profile: String? = nil
    ) {
        self.id = id
        self.displayName = displayName
        self.callSiteDescription = callSiteDescription
        self.domain = domain
        self.provider = provider
        self.model = model
        self.profile = profile
    }

    /// True when this entry has at least one explicit override.
    public var hasOverride: Bool {
        provider != nil || model != nil || profile != nil
    }
}

/// Catalog of every LLM call site the assistant exposes.
///
/// Display metadata is owned by the assistant runtime's
/// `config/llm/call-sites` API. The client may hydrate from the last cached
/// response while fetching, but must not define a parallel call-site list.
@MainActor
@Observable
public final class CallSiteCatalog {
    public static let shared = CallSiteCatalog()

    public private(set) var domains: [CallSiteDomain]
    public private(set) var callSites: [CallSiteOverride]
    public private(set) var isLoaded: Bool = false
    /// True while an API request is in flight. Never true when `callSites` is
    /// non-empty from cache — only meaningful alongside an empty list.
    public private(set) var isFetching: Bool = false
    /// True after a fetch attempt completed with no usable response (network
    /// error, 4xx/5xx, or decode failure) and no cached data is available.
    /// Cleared on the next successful fetch.
    public private(set) var loadFailed: Bool = false

    @ObservationIgnored private var fetchTask: (id: UUID, task: Task<CallSiteCatalogResponse?, Never>)?
    @ObservationIgnored private var latestRequestId: UUID?

    private static let cachedResponseKey = "llmCallSiteCatalogResponse.v1"

    private init() {
        if let cached = Self.loadCachedResponse() {
            self.domains = Self.domains(from: cached)
            self.callSites = Self.callSites(from: cached)
        } else {
            self.domains = []
            self.callSites = []
        }
    }

    /// Fetch the catalog from the assistant API if not already loaded.
    /// Safe to call multiple times — concurrent callers share one request.
    @discardableResult
    @MainActor public func ensureLoaded(using client: SettingsClientProtocol = SettingsClient()) async -> Bool {
        await load(using: client, force: false)
    }

    /// Re-fetch the catalog even when a prior response has already loaded.
    @discardableResult
    @MainActor public func reload(using client: SettingsClientProtocol = SettingsClient()) async -> Bool {
        await load(using: client, force: true)
    }

    @discardableResult
    private func load(using client: SettingsClientProtocol, force: Bool) async -> Bool {
        if isLoaded && !force {
            return true
        }

        let requestId: UUID
        let task: Task<CallSiteCatalogResponse?, Never>
        if let fetchTask, !force {
            // Join the in-flight request — isFetching is already true.
            requestId = fetchTask.id
            task = fetchTask.task
        } else {
            requestId = UUID()
            let newTask = Task { @MainActor in await client.fetchCallSiteCatalog() }
            latestRequestId = requestId
            fetchTask = (id: requestId, task: newTask)
            task = newTask
            isFetching = true
        }

        let response = await task.value
        if fetchTask?.id == requestId {
            fetchTask = nil
        }

        // A newer reload() superseded this request — leave isFetching alone;
        // the newer request owns it.
        guard latestRequestId == requestId else {
            return false
        }

        isFetching = false

        guard let response else {
            loadFailed = true
            log.error(
                "CallSiteCatalog fetch failed — daemon may be running without GET config/llm/call-sites. " +
                "The Action Overrides sheet will be empty until the daemon is updated and the sheet is reopened."
            )
            return false
        }

        loadFailed = false
        apply(response)
        Self.storeCachedResponse(response)
        isLoaded = true
        return true
    }

    // MARK: - Computed accessors

    public var byId: [String: CallSiteOverride] {
        Dictionary(uniqueKeysWithValues: callSites.map { ($0.id, $0) })
    }

    public var validIds: Set<String> { Set(callSites.map(\.id)) }

    public func entries(for domain: CallSiteDomain) -> [CallSiteOverride] {
        callSites.filter { $0.domain == domain.id }
    }

    // MARK: - Backward compat static shims

    /// Returns the current catalog entries. Pre-seeded at startup so
    /// SettingsStore and tests have data immediately without an API fetch.
    public static var all: [CallSiteOverride] { shared.callSites }
    public static var byId: [String: CallSiteOverride] { shared.byId }
    public static var validIds: Set<String> { shared.validIds }

    // MARK: - Catalog hydration

    private func apply(_ response: CallSiteCatalogResponse) {
        domains = Self.domains(from: response)
        callSites = Self.callSites(from: response)
    }

    private static func domains(from response: CallSiteCatalogResponse) -> [CallSiteDomain] {
        response.domains.map { CallSiteDomain(id: $0.id, displayName: $0.displayName) }
    }

    private static func callSites(from response: CallSiteCatalogResponse) -> [CallSiteOverride] {
        response.callSites.map {
            CallSiteOverride(
                id: $0.id,
                displayName: $0.displayName,
                callSiteDescription: $0.description,
                domain: $0.domain
            )
        }
    }

    private static func loadCachedResponse() -> CallSiteCatalogResponse? {
        guard let data = UserDefaults.standard.data(forKey: cachedResponseKey) else {
            return nil
        }
        return try? JSONDecoder().decode(CallSiteCatalogResponse.self, from: data)
    }

    private static func storeCachedResponse(_ response: CallSiteCatalogResponse) {
        guard let data = try? JSONEncoder().encode(response) else {
            return
        }
        UserDefaults.standard.set(data, forKey: cachedResponseKey)
    }

    func replaceForTesting(_ response: CallSiteCatalogResponse, isLoaded: Bool = true) {
        fetchTask = nil
        latestRequestId = nil
        isFetching = false
        loadFailed = false
        apply(response)
        self.isLoaded = isLoaded
    }

    func clearForTesting() {
        fetchTask = nil
        latestRequestId = nil
        domains = []
        callSites = []
        isLoaded = false
        isFetching = false
        loadFailed = false
        UserDefaults.standard.removeObject(forKey: Self.cachedResponseKey)
    }
}
