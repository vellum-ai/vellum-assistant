import Foundation
import ImageIO

enum LocalNotificationPresentation: String, Sendable {
    case assistant
    case app
}

enum LocalNotificationNameProvenance: String, Sendable {
    case event
    case identityStore = "identity-store"
    case verifiedMemory = "verified-memory"
    case title
}

struct LocalNotificationIdentity: Hashable, Sendable {
    let scopeId: String
    let assistantId: String
    let nativeSenderId: String
}

struct LocalNotificationAvatar: Equatable, Sendable {
    let data: Data
    let hash: String
}

struct LocalNotificationSender: Equatable, Sendable {
    let id: String
    let name: String
    let avatar: LocalNotificationAvatar
}

struct LocalNotificationPreparedIdentityUpdate: Sendable {
    let identity: LocalNotificationIdentity
    let scopeEpoch: Int
    let identityRevision: Int
    let name: String?
    let avatar: LocalNotificationAvatar?
}

struct LocalNotificationPostRequest<Content: Sendable>: Sendable {
    let deliveryKey: String
    let notificationId: Int
    let plainContent: Content
    let presentation: LocalNotificationPresentation
    let identity: LocalNotificationIdentity?
    let senderName: String?
    let nameProvenance: LocalNotificationNameProvenance?
    let suppressGroupTitle: Bool
    let inlineSender: LocalNotificationSender?
    let inlineSenderInvalid: Bool
}

enum LocalNotificationDeliveryResult: Equatable, Sendable {
    case posted
    case duplicate
    case blocked(reason: String?)
    case failed(postingMayHaveBegun: Bool, errorMessage: String?)
    case unknown(errorMessage: String?)
    case unavailable(reason: String?)

    fileprivate var repeatedPostResult: LocalNotificationDeliveryResult {
        switch self {
        case .posted, .duplicate:
            return .duplicate
        default:
            return self
        }
    }
}

protocol LocalNotificationClock: Sendable {
    func sleep(for duration: Duration) async
}

struct ContinuousLocalNotificationClock: LocalNotificationClock {
    func sleep(for duration: Duration) async {
        try? await Task.sleep(for: duration)
    }
}

enum LocalNotificationDeliveryKey {
    static let maxCharacters = 512

    static func resolve(
        correlationId: String?,
        deliveryId: String?,
        requestKey: String?
    ) -> String? {
        for candidate in [correlationId, deliveryId, requestKey] {
            let trimmed = candidate?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !trimmed.isEmpty && trimmed.count <= maxCharacters {
                return trimmed
            }
        }
        return nil
    }
}

/// Allocation-safe validation for the inline PNGs accepted from the web view.
/// The byte and dimension limits match the notification avatar policy already
/// used by the native caches. Metadata is checked before ImageIO is allowed to
/// decode pixels, and the decoded thumbnail proves the file is an image rather
/// than a byte sequence with a plausible header.
enum LocalNotificationAvatarValidator {
    static let maxPixels = 512
    static let maxEncodedCharacters = ((AvatarCache.maxBytes + 2) / 3) * 4

    static func decode(base64: String, expectedHash: String) -> LocalNotificationAvatar? {
        let encodedCount = base64.utf8.count
        guard encodedCount >= 4, encodedCount <= maxEncodedCharacters,
              AvatarCache.isValidHash(expectedHash),
              let data = Data(base64Encoded: base64),
              !data.isEmpty,
              data.count <= AvatarCache.maxBytes,
              AvatarCache.sha256Hex(data) == expectedHash,
              hasSupportedDimensions(data)
        else {
            return nil
        }
        return LocalNotificationAvatar(data: data, hash: expectedHash)
    }

    private static func hasSupportedDimensions(_ data: Data) -> Bool {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              CGImageSourceGetCount(source) == 1,
              CGImageSourceGetType(source) as String? == "public.png",
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil)
                  as? [CFString: Any],
              let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
              let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue,
              width > 0,
              height > 0,
              width <= maxPixels,
              height <= maxPixels
        else {
            return false
        }

        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixels,
            kCGImageSourceShouldCacheImmediately: false,
        ]
        guard let decoded = CGImageSourceCreateThumbnailAtIndex(
            source,
            0,
            options as CFDictionary
        ) else {
            return false
        }
        return decoded.width > 0
            && decoded.height > 0
            && decoded.width <= maxPixels
            && decoded.height <= maxPixels
    }
}

/// Process-local owner for native notification delivery.
///
/// A delivery key is claimed before rewrite work starts. Concurrent callers
/// share the same task, completed results stay as bounded no-repost records,
/// and a preparation deadline selects either rewritten or original content.
/// The losing rewrite can finish later, but it has no path to the writer.
actor LocalNotificationCoordinator<Content: Sendable> {
    typealias ContentPreparer = @Sendable (
        _ plainContent: Content,
        _ sender: LocalNotificationSender,
        _ suppressGroupTitle: Bool
    ) async throws -> Content
    typealias NotificationWriter = @Sendable (
        _ notificationId: Int,
        _ content: Content
    ) async -> LocalNotificationDeliveryResult

    static var defaultPreparationDeadline: Duration { .milliseconds(750) }
    static var defaultPreparedIdentityLimit: Int { 8 }
    static var defaultCompletedResultLimit: Int { 128 }
    static var defaultScopeLimit: Int { 16 }

    private struct IdentityKey: Hashable, Sendable {
        let scopeId: String
        let assistantId: String
    }

    private struct PreparedIdentity: Sendable {
        let identity: LocalNotificationIdentity
        let revision: Int
        let name: String?
        let avatar: LocalNotificationAvatar?
    }

    private struct ScopeState: Sendable {
        let epoch: Int
        let sealedEpoch: Int?
    }

    private struct IdentityGeneration: Sendable {
        let scopeEpoch: Int
        let identityRevision: Int
        let revisionTombstone: Bool
    }

    private struct PublisherIdentityGeneration: Sendable {
        let localRevision: Int
        let nativeRevision: Int
        var tombstone: Bool
    }

    private struct PublisherScopeGeneration: Sendable {
        let localEpoch: Int
        let nativeEpoch: Int
        var sealed: Bool
        var identities: [String: PublisherIdentityGeneration]
    }

    private struct PublisherSourceState: Sendable {
        var activeSessionId: String
        var registrationGeneration: Int?
        var retiredSessionIds: [String]
        var scopes: [String: PublisherScopeGeneration]
    }

    private let clock: any LocalNotificationClock
    private let preparationDeadline: Duration
    private let preparedIdentityLimit: Int
    private let identityGenerationLimit: Int
    private let scopeLimit: Int
    private let completedResultLimit: Int
    private let contentPreparer: ContentPreparer
    private let notificationWriter: NotificationWriter

    private var preparedIdentities: [IdentityKey: PreparedIdentity] = [:]
    private var preparedIdentityOrder: [IdentityKey] = []
    private var scopeStates: [String: ScopeState] = [:]
    private var identityGenerations: [IdentityKey: IdentityGeneration] = [:]
    private var identityGenerationOrder: [IdentityKey] = []
    private var publisherSources: [String: PublisherSourceState] = [:]
    private var inFlight: [String: Task<LocalNotificationDeliveryResult, Never>] = [:]
    private var completed: [String: LocalNotificationDeliveryResult] = [:]
    private var completedOrder: [String] = []

    init(
        clock: any LocalNotificationClock = ContinuousLocalNotificationClock(),
        preparationDeadline: Duration = LocalNotificationCoordinator.defaultPreparationDeadline,
        preparedIdentityLimit: Int = LocalNotificationCoordinator.defaultPreparedIdentityLimit,
        scopeLimit: Int = LocalNotificationCoordinator.defaultScopeLimit,
        completedResultLimit: Int = LocalNotificationCoordinator.defaultCompletedResultLimit,
        contentPreparer: @escaping ContentPreparer,
        notificationWriter: @escaping NotificationWriter
    ) {
        self.clock = clock
        self.preparationDeadline = preparationDeadline
        self.preparedIdentityLimit = max(1, preparedIdentityLimit)
        identityGenerationLimit = max(
            self.preparedIdentityLimit * 2,
            LocalNotificationCoordinator.defaultScopeLimit
        )
        self.scopeLimit = max(1, scopeLimit)
        self.completedResultLimit = max(1, completedResultLimit)
        self.contentPreparer = contentPreparer
        self.notificationWriter = notificationWriter
    }

    @discardableResult
    func registerPublisherSession(
        sourceId: String,
        sessionId: String,
        registrationGeneration: Int? = nil
    ) -> Bool {
        guard !sourceId.isEmpty, !sessionId.isEmpty else {
            return false
        }
        guard var source = publisherSources[sourceId] else {
            guard publisherSources.count < scopeLimit else {
                return false
            }
            publisherSources[sourceId] = PublisherSourceState(
                activeSessionId: sessionId,
                registrationGeneration: registrationGeneration,
                retiredSessionIds: [],
                scopes: [:]
            )
            return true
        }
        if source.activeSessionId == sessionId {
            if let registrationGeneration {
                if let current = source.registrationGeneration,
                   registrationGeneration < current {
                    return false
                }
                source.registrationGeneration = registrationGeneration
                publisherSources[sourceId] = source
            }
            return true
        }
        if let registrationGeneration,
           let current = source.registrationGeneration,
           registrationGeneration <= current {
            return false
        }
        if source.retiredSessionIds.contains(sessionId) {
            return false
        }
        source.retiredSessionIds.append(source.activeSessionId)
        if source.retiredSessionIds.count > 16 {
            source.retiredSessionIds.removeFirst(
                source.retiredSessionIds.count - 16
            )
        }
        source.activeSessionId = sessionId
        source.registrationGeneration = registrationGeneration
        source.scopes.removeAll()
        publisherSources[sourceId] = source
        return true
    }

    @discardableResult
    func prepare(
        _ update: LocalNotificationPreparedIdentityUpdate,
        publisherSourceId: String? = nil,
        publisherSessionId: String? = nil
    ) -> Bool {
        guard update.scopeEpoch >= 0, update.identityRevision >= 0 else {
            return false
        }
        guard let translated = translatePublisherTarget(
            sourceId: publisherSourceId,
            sessionId: publisherSessionId,
            scopeId: update.identity.scopeId,
            assistantId: update.identity.assistantId,
            localEpoch: update.scopeEpoch,
            localRevision: update.identityRevision,
            tombstone: false
        ) else {
            return false
        }
        let update = LocalNotificationPreparedIdentityUpdate(
            identity: update.identity,
            scopeEpoch: translated.scopeEpoch,
            identityRevision: translated.identityRevision,
            name: update.name,
            avatar: update.avatar
        )
        let key = IdentityKey(
            scopeId: update.identity.scopeId,
            assistantId: update.identity.assistantId
        )
        guard acceptScopeEpoch(update.scopeEpoch, scopeId: update.identity.scopeId) else {
            return false
        }
        if let generation = identityGenerations[key] {
            if update.scopeEpoch < generation.scopeEpoch {
                return false
            }
            if update.scopeEpoch == generation.scopeEpoch {
                let staleRevision = generation.revisionTombstone
                    ? update.identityRevision <= generation.identityRevision
                    : update.identityRevision < generation.identityRevision
                if staleRevision {
                    return false
                }
            }
        }

        let existing = preparedIdentities[key]
        if let existing, update.identityRevision < existing.revision {
            return false
        }
        let sameOwner = existing?.identity == update.identity
        let prepared = PreparedIdentity(
            identity: update.identity,
            revision: update.identityRevision,
            name: update.name ?? (sameOwner ? existing?.name : nil),
            avatar: update.avatar ?? (sameOwner ? existing?.avatar : nil)
        )
        guard prepared.name != nil || prepared.avatar != nil else {
            return false
        }
        let generation = IdentityGeneration(
            scopeEpoch: update.scopeEpoch,
            identityRevision: update.identityRevision,
            revisionTombstone: false
        )
        guard setIdentityGeneration(generation, for: key) else {
            return false
        }
        preparedIdentities[key] = prepared
        touch(key, in: &preparedIdentityOrder)
        prunePreparedIdentities()
        return true
    }

    @discardableResult
    func reset(
        scopeId: String,
        scopeEpoch: Int,
        assistantId: String?,
        identityRevision: Int? = nil,
        publisherSourceId: String? = nil,
        publisherSessionId: String? = nil
    ) -> Bool {
        guard scopeEpoch >= 0,
              identityRevision == nil || assistantId != nil,
              identityRevision.map({ $0 >= 0 }) ?? true
        else {
            return false
        }
        let translatedScopeEpoch: Int
        var translatedIdentityRevision = identityRevision
        if let assistantId {
            guard let translated = translatePublisherTarget(
                sourceId: publisherSourceId,
                sessionId: publisherSessionId,
                scopeId: scopeId,
                assistantId: assistantId,
                localEpoch: scopeEpoch,
                localRevision: identityRevision ?? 0,
                tombstone: true
            ) else {
                return false
            }
            translatedScopeEpoch = translated.scopeEpoch
            translatedIdentityRevision = translated.identityRevision
        } else {
            guard let translated = translatePublisherScopeReset(
                sourceId: publisherSourceId,
                sessionId: publisherSessionId,
                scopeId: scopeId,
                localEpoch: scopeEpoch
            ) else {
                return false
            }
            translatedScopeEpoch = translated
        }
        let scopeEpoch = translatedScopeEpoch
        let identityRevision = translatedIdentityRevision
        guard let scopeUpdate = updateScopeEpoch(scopeEpoch, scopeId: scopeId) else {
            return false
        }

        if let assistantId {
            if let sealedEpoch = scopeUpdate.state.sealedEpoch,
               scopeEpoch <= sealedEpoch {
                return true
            }
            let key = IdentityKey(scopeId: scopeId, assistantId: assistantId)
            let knownRevision = identityGenerations[key]
                .flatMap { $0.scopeEpoch == scopeEpoch ? $0.identityRevision : nil }
                ?? -1
            if let identityRevision, identityRevision < knownRevision {
                return false
            }
            preparedIdentities.removeValue(forKey: key)
            preparedIdentityOrder.removeAll { $0 == key }
            let generation = IdentityGeneration(
                scopeEpoch: scopeEpoch,
                identityRevision: max(identityRevision ?? -1, knownRevision),
                revisionTombstone: true
            )
            _ = setIdentityGeneration(generation, for: key)
        } else {
            clearIdentityState(scopeId: scopeId)
            if !scopeUpdate.advanced {
                scopeStates[scopeId] = ScopeState(
                    epoch: scopeEpoch,
                    sealedEpoch: scopeEpoch
                )
            }
        }
        return true
    }

    private func nextGeneration(_ current: Int) -> Int? {
        current < Int.max ? current + 1 : nil
    }

    private func nativeScopeEpochForTarget(_ scopeId: String) -> Int? {
        guard let scope = scopeStates[scopeId] else {
            return 0
        }
        if let sealedEpoch = scope.sealedEpoch, scope.epoch <= sealedEpoch {
            return nextGeneration(scope.epoch)
        } else {
            return scope.epoch
        }
    }

    private func nextNativeScopeEpoch(_ scopeId: String) -> Int? {
        nextGeneration(scopeStates[scopeId]?.epoch ?? -1)
    }

    private func nativeIdentityRevision(
        scopeId: String,
        assistantId: String,
        scopeEpoch: Int
    ) -> Int {
        let key = IdentityKey(scopeId: scopeId, assistantId: assistantId)
        guard let generation = identityGenerations[key],
              generation.scopeEpoch == scopeEpoch else {
            return -1
        }
        return generation.identityRevision
    }

    private func translatePublisherTarget(
        sourceId: String?,
        sessionId: String?,
        scopeId: String,
        assistantId: String,
        localEpoch: Int,
        localRevision: Int,
        tombstone: Bool
    ) -> (scopeEpoch: Int, identityRevision: Int)? {
        guard let sessionId else {
            if let sourceId, publisherSources[sourceId] != nil {
                return nil
            }
            return (localEpoch, localRevision)
        }
        guard let sourceId,
              var source = publisherSources[sourceId],
              source.activeSessionId == sessionId else {
            return nil
        }

        var scope = source.scopes[scopeId]
        if scope == nil || localEpoch > scope!.localEpoch {
            let createsScope = scope == nil
            let nativeEpoch = createsScope
                ? nativeScopeEpochForTarget(scopeId)
                : nextNativeScopeEpoch(scopeId)
            guard let nativeEpoch,
                  !createsScope || source.scopes.count < scopeLimit else {
                return nil
            }
            scope = PublisherScopeGeneration(
                localEpoch: localEpoch,
                nativeEpoch: nativeEpoch,
                sealed: false,
                identities: [:]
            )
        } else if localEpoch < scope!.localEpoch || scope!.sealed {
            return nil
        }

        var mapped = scope!.identities[assistantId]
        if let mapped, localRevision < mapped.localRevision {
            return nil
        }
        if mapped?.localRevision == localRevision {
            if mapped!.tombstone && !tombstone {
                return nil
            }
            if tombstone {
                mapped!.tombstone = true
                scope!.identities[assistantId] = mapped
            }
        } else {
            guard mapped != nil || scope!.identities.count < identityGenerationLimit,
                  let nativeRevision = nextGeneration(nativeIdentityRevision(
                    scopeId: scopeId,
                    assistantId: assistantId,
                    scopeEpoch: scope!.nativeEpoch
                  )) else {
                return nil
            }
            mapped = PublisherIdentityGeneration(
                localRevision: localRevision,
                nativeRevision: nativeRevision,
                tombstone: tombstone
            )
            scope!.identities[assistantId] = mapped
        }
        source.scopes[scopeId] = scope
        publisherSources[sourceId] = source
        return (scope!.nativeEpoch, mapped!.nativeRevision)
    }

    private func translatePublisherScopeReset(
        sourceId: String?,
        sessionId: String?,
        scopeId: String,
        localEpoch: Int
    ) -> Int? {
        guard let sessionId else {
            if let sourceId, publisherSources[sourceId] != nil {
                return nil
            }
            return localEpoch
        }
        guard let sourceId,
              var source = publisherSources[sourceId],
              source.activeSessionId == sessionId else {
            return nil
        }
        if let mapped = source.scopes[scopeId] {
            if localEpoch < mapped.localEpoch {
                return nil
            }
            if localEpoch == mapped.localEpoch && mapped.sealed {
                return mapped.nativeEpoch
            }
        } else if source.scopes.count >= scopeLimit {
            return nil
        }
        guard let nativeEpoch = nextNativeScopeEpoch(scopeId) else {
            return nil
        }
        source.scopes[scopeId] = PublisherScopeGeneration(
            localEpoch: localEpoch,
            nativeEpoch: nativeEpoch,
            sealed: true,
            identities: [:]
        )
        publisherSources[sourceId] = source
        return nativeEpoch
    }

    func post(
        _ request: LocalNotificationPostRequest<Content>
    ) async -> LocalNotificationDeliveryResult {
        if let result = completed[request.deliveryKey] {
            return result.repeatedPostResult
        }
        if let existing = inFlight[request.deliveryKey] {
            return await existing.value
        }

        let sender = sender(for: request)
        let clock = clock
        let deadline = preparationDeadline
        let contentPreparer = contentPreparer
        let notificationWriter = notificationWriter
        let task = Task {
            let selectedContent: Content
            if let sender {
                selectedContent = await Self.selectContent(
                    plainContent: request.plainContent,
                    sender: sender,
                    suppressGroupTitle: request.suppressGroupTitle,
                    deadline: deadline,
                    clock: clock,
                    contentPreparer: contentPreparer
                )
            } else {
                selectedContent = request.plainContent
            }
            return await notificationWriter(request.notificationId, selectedContent)
        }
        inFlight[request.deliveryKey] = task
        let result = await task.value
        inFlight.removeValue(forKey: request.deliveryKey)
        remember(result, for: request.deliveryKey)
        return result
    }

    /// Read-only state for bridge watchdog reconciliation. An in-flight owner
    /// is unknown until its sole writer finishes; absence means this process
    /// has no retained knowledge of the key.
    func status(for deliveryKey: String) -> LocalNotificationDeliveryResult {
        if let result = completed[deliveryKey] {
            return result
        }
        if inFlight[deliveryKey] != nil {
            return .unknown(errorMessage: "delivery_in_flight")
        }
        return .unavailable(reason: "delivery_not_found")
    }

    private func sender(
        for request: LocalNotificationPostRequest<Content>
    ) -> LocalNotificationSender? {
        guard request.presentation == .assistant,
              !request.inlineSenderInvalid,
              let identity = request.identity
        else {
            return nil
        }
        if let inline = request.inlineSender {
            guard inline.id == identity.nativeSenderId else {
                return nil
            }
            return inline
        }

        let key = IdentityKey(scopeId: identity.scopeId, assistantId: identity.assistantId)
        guard let prepared = preparedIdentities[key],
              prepared.identity == identity,
              let avatar = prepared.avatar
        else {
            return nil
        }
        let requestedName = request.senderName?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let name = requestedName?.isEmpty == false ? requestedName : prepared.name
        guard let name, !name.isEmpty else {
            return nil
        }
        return LocalNotificationSender(id: identity.nativeSenderId, name: name, avatar: avatar)
    }

    private static func selectContent(
        plainContent: Content,
        sender: LocalNotificationSender,
        suppressGroupTitle: Bool,
        deadline: Duration,
        clock: any LocalNotificationClock,
        contentPreparer: @escaping ContentPreparer
    ) async -> Content {
        let selection = OneShot<PreparationSelection<Content>>()
        let preparation = Task {
            do {
                let content = try await contentPreparer(
                    plainContent,
                    sender,
                    suppressGroupTitle
                )
                selection.resolve(.prepared(content))
            } catch {
                selection.resolve(.plain)
            }
        }
        let timer = Task {
            await clock.sleep(for: deadline)
            if !Task.isCancelled {
                selection.resolve(.plain)
            }
        }
        let selected = await selection.wait()
        preparation.cancel()
        timer.cancel()
        switch selected {
        case .prepared(let content):
            return content
        case .plain:
            return plainContent
        }
    }

    private func acceptScopeEpoch(_ epoch: Int, scopeId: String) -> Bool {
        guard let update = updateScopeEpoch(epoch, scopeId: scopeId) else {
            return false
        }
        return update.state.sealedEpoch.map { epoch > $0 } ?? true
    }

    private func updateScopeEpoch(
        _ epoch: Int,
        scopeId: String
    ) -> (state: ScopeState, advanced: Bool)? {
        guard let state = scopeStates[scopeId] else {
            guard scopeStates.count < scopeLimit else {
                return nil
            }
            let admitted = ScopeState(epoch: epoch, sealedEpoch: nil)
            scopeStates[scopeId] = admitted
            return (admitted, true)
        }
        if epoch < state.epoch {
            return nil
        }
        if epoch > state.epoch {
            clearIdentityState(scopeId: scopeId)
            let advanced = ScopeState(epoch: epoch, sealedEpoch: nil)
            scopeStates[scopeId] = advanced
            return (advanced, true)
        }
        return (state, false)
    }

    private func sealScope(_ scopeId: String) {
        guard let state = scopeStates[scopeId] else {
            return
        }
        clearIdentityState(scopeId: scopeId)
        scopeStates[scopeId] = ScopeState(
            epoch: state.epoch,
            sealedEpoch: max(state.sealedEpoch ?? -1, state.epoch)
        )
    }

    private func setIdentityGeneration(
        _ generation: IdentityGeneration,
        for key: IdentityKey
    ) -> Bool {
        if identityGenerations[key] == nil {
            while identityGenerations.count >= identityGenerationLimit {
                guard let oldest = identityGenerationOrder.first,
                      identityGenerations[oldest] != nil else {
                    return false
                }
                sealScope(oldest.scopeId)
                if identityGenerations[oldest] != nil {
                    return false
                }
            }
        }
        guard let scope = scopeStates[key.scopeId],
              scope.sealedEpoch.map({ generation.scopeEpoch > $0 }) ?? true
        else {
            return false
        }
        identityGenerations[key] = generation
        touch(key, in: &identityGenerationOrder)
        return true
    }

    private func clearIdentityState(scopeId: String) {
        let preparedKeys = preparedIdentities.keys.filter { $0.scopeId == scopeId }
        for key in preparedKeys {
            preparedIdentities.removeValue(forKey: key)
        }
        preparedIdentityOrder.removeAll { $0.scopeId == scopeId }

        let generationKeys = identityGenerations.keys.filter { $0.scopeId == scopeId }
        for key in generationKeys {
            identityGenerations.removeValue(forKey: key)
        }
        identityGenerationOrder.removeAll { $0.scopeId == scopeId }
    }

    private func prunePreparedIdentities() {
        while preparedIdentityOrder.count > preparedIdentityLimit {
            let evicted = preparedIdentityOrder.removeFirst()
            preparedIdentities.removeValue(forKey: evicted)
        }
    }

    private func remember(_ result: LocalNotificationDeliveryResult, for deliveryKey: String) {
        completed[deliveryKey] = result
        touch(deliveryKey, in: &completedOrder)
        while completedOrder.count > completedResultLimit {
            let evicted = completedOrder.removeFirst()
            completed.removeValue(forKey: evicted)
        }
    }

    private func touch<Value: Equatable>(_ value: Value, in order: inout [Value]) {
        order.removeAll { $0 == value }
        order.append(value)
    }
}

private enum PreparationSelection<Content: Sendable>: Sendable {
    case prepared(Content)
    case plain
}

/// First-completion gate for the rewrite/deadline race. A task that ignores
/// cancellation can resolve late, but the continuation and selected value are
/// spent exactly once.
private final class OneShot<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Value, Never>?
    private var resolvedValue: Value?
    private var resolved = false

    func wait() async -> Value {
        await withCheckedContinuation { continuation in
            lock.lock()
            if resolved, let value = resolvedValue {
                resolvedValue = nil
                lock.unlock()
                continuation.resume(returning: value)
                return
            }
            self.continuation = continuation
            lock.unlock()
        }
    }

    func resolve(_ value: Value) {
        lock.lock()
        guard !resolved else {
            lock.unlock()
            return
        }
        resolved = true
        if let continuation {
            self.continuation = nil
            lock.unlock()
            continuation.resume(returning: value)
            return
        }
        resolvedValue = value
        lock.unlock()
    }
}
