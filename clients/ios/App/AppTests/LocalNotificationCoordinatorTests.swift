import CoreGraphics
import ImageIO
import XCTest

final class LocalNotificationCoordinatorTests: XCTestCase {
    fileprivate struct TestContent: Equatable, Sendable {
        let title: String
        let body: String
        var senderName: String?
        var groupTitle: String?
    }

    private enum TestError: Error {
        case rewriteFailed
    }

    private let identity = LocalNotificationIdentity(
        scopeId: "scope-1",
        assistantId: "assistant-1",
        nativeSenderId: "native-assistant-1"
    )
    private let avatar = LocalNotificationAvatar(
        data: Data([0x01, 0x02, 0x03]),
        hash: String(repeating: "a", count: 64)
    )

    func testRewriteSuccessPostsPreparedContentOnce() async {
        let writer = WriteRecorder(result: .posted)
        let coordinator = makeCoordinator(writer: writer) { content, sender, suppressGroupTitle in
            var updated = content
            updated.senderName = sender.name
            updated.groupTitle = suppressGroupTitle ? nil : content.title
            return updated
        }

        let result = await coordinator.post(request(key: "delivery-1", inlineSender: sender()))

        XCTAssertEqual(result, .posted)
        let writes = await writer.snapshot()
        XCTAssertEqual(writes.count, 1)
        XCTAssertEqual(writes[0].id, 41)
        XCTAssertEqual(writes[0].content.senderName, "Assistant")
        XCTAssertEqual(writes[0].content.groupTitle, "Conversation")
    }

    func testRewriteErrorPostsOriginalContentOnce() async {
        let writer = WriteRecorder(result: .posted)
        let coordinator = makeCoordinator(writer: writer) { _, _, _ in
            throw TestError.rewriteFailed
        }

        let result = await coordinator.post(request(key: "delivery-error", inlineSender: sender()))

        XCTAssertEqual(result, .posted)
        let writes = await writer.snapshot()
        XCTAssertEqual(writes.count, 1)
        XCTAssertNil(writes[0].content.senderName)
        XCTAssertEqual(writes[0].content.title, "Conversation")
        XCTAssertEqual(writes[0].content.body, "Body")
    }

    func testHungRewriteSelectsPlainContentAndLateCompletionCannotPostAgain() async {
        let clock = ManualClock()
        let rewrite = AsyncGate<TestContent>()
        let writer = WriteRecorder(result: .posted)
        let coordinator = makeCoordinator(clock: clock, writer: writer) { _, _, _ in
            await rewrite.wait()
        }
        let post = Task {
            await coordinator.post(request(key: "delivery-timeout", inlineSender: sender()))
        }
        await waitUntilWaiting(clock)
        await waitUntilWaiting(rewrite)

        await clock.fire()
        let postResult = await post.value
        XCTAssertEqual(postResult, .posted)
        var writes = await writer.snapshot()
        XCTAssertEqual(writes.count, 1)
        XCTAssertNil(writes[0].content.senderName)

        await rewrite.open(
            TestContent(
                title: "Conversation",
                body: "Body",
                senderName: "Too Late",
                groupTitle: "Conversation"
            )
        )
        await Task.yield()
        writes = await writer.snapshot()
        XCTAssertEqual(writes.count, 1)
    }

    func testWriterFailureReportsPostingMayHaveBegun() async {
        let writer = WriteRecorder(
            result: .failed(postingMayHaveBegun: true, errorMessage: "add_failed")
        )
        let coordinator = makeCoordinator(writer: writer) { content, _, _ in content }

        let result = await coordinator.post(request(key: "delivery-failed"))

        XCTAssertEqual(
            result,
            .failed(postingMayHaveBegun: true, errorMessage: "add_failed")
        )
        let writeCount = await writer.count()
        XCTAssertEqual(writeCount, 1)
    }

    func testBlockedPermissionIsReportedWithoutChangingTheResult() async {
        let writer = WriteRecorder(result: .blocked(reason: "authorization_denied"))
        let coordinator = makeCoordinator(writer: writer) { content, _, _ in content }

        let result = await coordinator.post(request(key: "delivery-blocked"))

        XCTAssertEqual(result, .blocked(reason: "authorization_denied"))
        let writeCount = await writer.count()
        XCTAssertEqual(writeCount, 1)
    }

    func testUnknownResultIsRetainedWithoutReposting() async {
        let writer = WriteRecorder(result: .unknown(errorMessage: "callback_uncertain"))
        let coordinator = makeCoordinator(writer: writer) { content, _, _ in content }
        let notification = request(key: "delivery-unknown")

        let first = await coordinator.post(notification)
        let second = await coordinator.post(notification)
        let writeCount = await writer.count()

        XCTAssertEqual(first, .unknown(errorMessage: "callback_uncertain"))
        XCTAssertEqual(second, first)
        XCTAssertEqual(writeCount, 1)
    }

    func testCompletedDuplicateDoesNotWriteAgain() async {
        let writer = WriteRecorder(result: .posted)
        let coordinator = makeCoordinator(writer: writer) { content, _, _ in content }
        let notification = request(key: "delivery-duplicate")

        let first = await coordinator.post(notification)
        let second = await coordinator.post(notification)
        let writeCount = await writer.count()
        let status = await coordinator.status(for: "delivery-duplicate")
        XCTAssertEqual(first, .posted)
        XCTAssertEqual(second, .duplicate)
        XCTAssertEqual(writeCount, 1)
        XCTAssertEqual(status, .posted)
    }

    func testCompletedResultsAreBoundedByFullDeliveryKey() async {
        let writer = WriteRecorder(result: .posted)
        let coordinator = makeCoordinator(
            completedResultLimit: 1,
            writer: writer
        ) { content, _, _ in content }

        let first = await coordinator.post(request(key: "delivery-full-key-one"))
        let second = await coordinator.post(request(key: "delivery-full-key-two"))
        let evictedStatus = await coordinator.status(for: "delivery-full-key-one")
        let writeCount = await writer.count()

        XCTAssertEqual(first, .posted)
        XCTAssertEqual(second, .posted)
        XCTAssertEqual(evictedStatus, .unavailable(reason: "delivery_not_found"))
        XCTAssertEqual(writeCount, 2)
    }

    func testInFlightDuplicateSharesTheOwnerResult() async {
        let writerGate = AsyncGate<LocalNotificationDeliveryResult>()
        let writer = WriteRecorder(resultGate: writerGate)
        let coordinator = makeCoordinator(writer: writer) { content, _, _ in content }
        let notification = request(key: "delivery-in-flight")
        let first = Task { await coordinator.post(notification) }
        await waitUntilWriterStarted(writer)
        let second = Task { await coordinator.post(notification) }
        await Task.yield()

        let inFlightStatus = await coordinator.status(for: "delivery-in-flight")
        XCTAssertEqual(inFlightStatus, .unknown(errorMessage: "delivery_in_flight"))
        await writerGate.open(.posted)
        let firstResult = await first.value
        let secondResult = await second.value
        let writeCount = await writer.count()
        XCTAssertEqual(firstResult, .posted)
        XCTAssertEqual(secondResult, .posted)
        XCTAssertEqual(writeCount, 1)
    }

    func testResetInvalidatesPreparedMemoryAndLatePublication() async {
        let writer = WriteRecorder(result: .posted)
        let coordinator = makeCoordinator(writer: writer) { content, sender, _ in
            var updated = content
            updated.senderName = sender.name
            return updated
        }
        let update = preparedUpdate(epoch: 3, revision: 1)
        let initialPrepare = await coordinator.prepare(update)
        let reset = await coordinator.reset(
            scopeId: identity.scopeId,
            scopeEpoch: 3,
            assistantId: identity.assistantId,
            identityRevision: 1
        )
        let stalePrepare = await coordinator.prepare(preparedUpdate(epoch: 3, revision: 1))
        XCTAssertTrue(initialPrepare)
        XCTAssertTrue(reset)
        XCTAssertFalse(stalePrepare)

        let resetPost = await coordinator.post(
            request(key: "delivery-after-reset", senderName: "Assistant")
        )
        XCTAssertEqual(resetPost, .posted)
        var writes = await writer.snapshot()
        XCTAssertNil(writes[0].content.senderName)

        let nextPrepare = await coordinator.prepare(preparedUpdate(epoch: 3, revision: 2))
        let nextPost = await coordinator.post(
            request(key: "delivery-new-epoch", senderName: "Assistant")
        )
        XCTAssertTrue(nextPrepare)
        XCTAssertEqual(nextPost, .posted)
        writes = await writer.snapshot()
        XCTAssertEqual(writes[1].content.senderName, "Assistant")
    }

    func testPreparedIdentityMemoryEvictsTheLeastRecentOwner() async {
        let writer = WriteRecorder(result: .posted)
        let coordinator = makeCoordinator(
            preparedIdentityLimit: 1,
            writer: writer
        ) { content, sender, _ in
            var updated = content
            updated.senderName = sender.name
            return updated
        }
        let secondIdentity = LocalNotificationIdentity(
            scopeId: identity.scopeId,
            assistantId: "assistant-2",
            nativeSenderId: "native-assistant-2"
        )

        let firstPrepared = await coordinator.prepare(preparedUpdate(epoch: 1, revision: 1))
        let secondPrepared = await coordinator.prepare(LocalNotificationPreparedIdentityUpdate(
            identity: secondIdentity,
            scopeEpoch: 1,
            identityRevision: 1,
            name: "Second Assistant",
            avatar: avatar
        ))
        let result = await coordinator.post(request(
            key: "delivery-evicted-identity",
            senderName: "Assistant"
        ))

        XCTAssertTrue(firstPrepared)
        XCTAssertTrue(secondPrepared)
        XCTAssertEqual(result, .posted)
        let content = await writer.snapshot()[0].content
        XCTAssertNil(content.senderName)
    }

    func testInvalidInlineImageSelectsOnePlainPostEvenWithPreparedMemory() async {
        let bytes = Data("not an image".utf8)
        let hash = AvatarCache.sha256Hex(bytes)
        XCTAssertNil(LocalNotificationAvatarValidator.decode(
            base64: bytes.base64EncodedString(),
            expectedHash: hash
        ))

        let writer = WriteRecorder(result: .posted)
        let coordinator = makeCoordinator(writer: writer) { content, sender, _ in
            var updated = content
            updated.senderName = sender.name
            return updated
        }
        let prepared = await coordinator.prepare(preparedUpdate(epoch: 1, revision: 1))
        XCTAssertTrue(prepared)

        let result = await coordinator.post(request(
            key: "delivery-invalid-image",
            senderName: "Assistant",
            inlineSenderInvalid: true
        ))

        XCTAssertEqual(result, .posted)
        let writes = await writer.snapshot()
        XCTAssertEqual(writes.count, 1)
        XCTAssertNil(writes[0].content.senderName)
    }

    func testAvatarValidationChecksEncodedLengthHashAndDecodedDimensions() throws {
        let valid = try png(width: 1, height: 1)
        let validHash = AvatarCache.sha256Hex(valid)
        XCTAssertNotNil(LocalNotificationAvatarValidator.decode(
            base64: valid.base64EncodedString(),
            expectedHash: validHash
        ))
        XCTAssertNil(LocalNotificationAvatarValidator.decode(
            base64: valid.base64EncodedString(),
            expectedHash: String(repeating: "b", count: 64)
        ))
        XCTAssertNil(LocalNotificationAvatarValidator.decode(
            base64: String(
                repeating: "A",
                count: LocalNotificationAvatarValidator.maxEncodedCharacters + 4
            ),
            expectedHash: validHash
        ))

        let tooWide = try png(width: LocalNotificationAvatarValidator.maxPixels + 1, height: 1)
        XCTAssertNil(LocalNotificationAvatarValidator.decode(
            base64: tooWide.base64EncodedString(),
            expectedHash: AvatarCache.sha256Hex(tooWide)
        ))
    }

    func testTitleFallbackSuppressesDuplicateGroupTitle() async {
        let writer = WriteRecorder(result: .posted)
        let coordinator = makeCoordinator(writer: writer) { content, sender, suppressGroupTitle in
            var updated = content
            updated.senderName = sender.name
            updated.groupTitle = suppressGroupTitle ? nil : content.title
            return updated
        }
        let prepared = await coordinator.prepare(preparedUpdate(epoch: 1, revision: 1))
        XCTAssertTrue(prepared)

        let result = await coordinator.post(request(
            key: "delivery-title-fallback",
            senderName: "Conversation",
            provenance: .title,
            suppressGroupTitle: true
        ))

        XCTAssertEqual(result, .posted)
        let content = await writer.snapshot()[0].content
        XCTAssertEqual(content.title, "Conversation")
        XCTAssertEqual(content.senderName, "Conversation")
        XCTAssertNil(content.groupTitle)
    }

    func testAppPresentationIgnoresInlineAndPreparedSenders() async {
        let writer = WriteRecorder(result: .posted)
        let coordinator = makeCoordinator(writer: writer) { content, sender, _ in
            var updated = content
            updated.senderName = sender.name
            return updated
        }
        let prepared = await coordinator.prepare(preparedUpdate(epoch: 1, revision: 1))
        XCTAssertTrue(prepared)

        let result = await coordinator.post(request(
            key: "delivery-app-presentation",
            presentation: .app,
            inlineSender: sender()
        ))

        XCTAssertEqual(result, .posted)
        let content = await writer.snapshot()[0].content
        XCTAssertNil(content.senderName)
    }

    func testPreparedSenderRequiresTheExactNativeIdentityOwner() async {
        let writer = WriteRecorder(result: .posted)
        let coordinator = makeCoordinator(writer: writer) { content, sender, _ in
            var updated = content
            updated.senderName = sender.name
            return updated
        }
        let prepared = await coordinator.prepare(preparedUpdate(epoch: 1, revision: 1))
        let mismatchedIdentity = LocalNotificationIdentity(
            scopeId: identity.scopeId,
            assistantId: identity.assistantId,
            nativeSenderId: "native-assistant-other"
        )

        let result = await coordinator.post(request(
            key: "delivery-owner-mismatch",
            senderName: "Assistant",
            identity: mismatchedIdentity
        ))

        XCTAssertTrue(prepared)
        XCTAssertEqual(result, .posted)
        let content = await writer.snapshot()[0].content
        XCTAssertNil(content.senderName)
    }

    func testOlderTargetedResetDoesNotDeleteCurrentPreparedIdentity() async {
        let writer = WriteRecorder(result: .posted)
        let coordinator = makeCoordinator(writer: writer) { content, sender, _ in
            var updated = content
            updated.senderName = sender.name
            return updated
        }
        let prepared = await coordinator.prepare(preparedUpdate(epoch: 4, revision: 5))

        let reset = await coordinator.reset(
            scopeId: identity.scopeId,
            scopeEpoch: 4,
            assistantId: identity.assistantId,
            identityRevision: 4
        )
        let result = await coordinator.post(request(
            key: "delivery-after-stale-reset",
            senderName: "Assistant"
        ))

        XCTAssertTrue(prepared)
        XCTAssertFalse(reset)
        XCTAssertEqual(result, .posted)
        let content = await writer.snapshot()[0].content
        XCTAssertEqual(content.senderName, "Assistant")
    }

    func testGenerationPressureSealsOldestScopeWithoutForgettingItsFloor() async {
        let writer = WriteRecorder(result: .posted)
        let coordinator = makeCoordinator(writer: writer) { content, sender, _ in
            var updated = content
            updated.senderName = sender.name
            return updated
        }
        let retainedOwner = makeIdentity(
            scopeId: "scope-sealed",
            assistantId: "assistant-retained"
        )
        let resetOwner = makeIdentity(
            scopeId: retainedOwner.scopeId,
            assistantId: "assistant-reset"
        )
        let churnScope = "scope-active"
        let retained = await coordinator.prepare(preparedUpdate(
            for: retainedOwner,
            epoch: 2,
            revision: 1
        ))
        let tombstoned = await coordinator.reset(
            scopeId: resetOwner.scopeId,
            scopeEpoch: 2,
            assistantId: resetOwner.assistantId,
            identityRevision: 10
        )

        for index in 0..<15 {
            let churnOwner = makeIdentity(
                scopeId: churnScope,
                assistantId: "assistant-\(index)"
            )
            let reset = await coordinator.reset(
                scopeId: churnScope,
                scopeEpoch: 0,
                assistantId: churnOwner.assistantId,
                identityRevision: 0
            )
            XCTAssertTrue(reset)
        }

        let postAfterCompaction = await coordinator.post(request(
            key: "delivery-after-scope-seal",
            senderName: "Retained Assistant",
            identity: retainedOwner
        ))
        let delayedPublication = await coordinator.prepare(preparedUpdate(
            for: resetOwner,
            epoch: 2,
            revision: 5
        ))
        let reopenedPublication = await coordinator.prepare(preparedUpdate(
            for: resetOwner,
            epoch: 3,
            revision: 0
        ))
        let retainedScopePublication = await coordinator.prepare(preparedUpdate(
            for: makeIdentity(scopeId: churnScope, assistantId: "assistant-0"),
            epoch: 0,
            revision: 1
        ))

        XCTAssertTrue(retained)
        XCTAssertTrue(tombstoned)
        XCTAssertEqual(postAfterCompaction, .posted)
        let content = await writer.snapshot()[0].content
        XCTAssertNil(content.senderName)
        XCTAssertFalse(delayedPublication)
        XCTAssertTrue(reopenedPublication)
        XCTAssertTrue(retainedScopePublication)
    }

    func testFullSameEpochResetSealsUntilAHigherEpochReopensTheScope() async {
        let writer = WriteRecorder(result: .posted)
        let coordinator = makeCoordinator(writer: writer) { content, _, _ in content }
        let prepared = await coordinator.prepare(preparedUpdate(epoch: 4, revision: 1))

        let sealed = await coordinator.reset(
            scopeId: identity.scopeId,
            scopeEpoch: 4,
            assistantId: nil
        )
        let sameEpoch = await coordinator.prepare(preparedUpdate(epoch: 4, revision: 2))
        let reopened = await coordinator.reset(
            scopeId: identity.scopeId,
            scopeEpoch: 5,
            assistantId: nil
        )
        let nextEpoch = await coordinator.prepare(preparedUpdate(epoch: 5, revision: 0))

        XCTAssertTrue(prepared)
        XCTAssertTrue(sealed)
        XCTAssertFalse(sameEpoch)
        XCTAssertTrue(reopened)
        XCTAssertTrue(nextEpoch)
    }

    func testScopeBudgetFailsClosedAndFreshCoordinatorStartsEmpty() async {
        let writer = WriteRecorder(result: .posted)
        let coordinator = makeCoordinator(writer: writer) { content, _, _ in content }

        for index in 0..<LocalNotificationCoordinator<TestContent>.defaultScopeLimit {
            let owner = makeIdentity(
                scopeId: "scope-\(index)",
                assistantId: "assistant-a"
            )
            let accepted = await coordinator.prepare(preparedUpdate(
                for: owner,
                epoch: 1,
                revision: 0
            ))
            XCTAssertTrue(accepted)
        }

        let overflow = makeIdentity(
            scopeId: "scope-overflow",
            assistantId: "assistant-a"
        )
        let rejectedPrepare = await coordinator.prepare(preparedUpdate(
            for: overflow,
            epoch: 1,
            revision: 0
        ))
        let rejectedReset = await coordinator.reset(
            scopeId: overflow.scopeId,
            scopeEpoch: 1,
            assistantId: nil
        )
        let retainedScope = await coordinator.prepare(preparedUpdate(
            for: makeIdentity(scopeId: "scope-0", assistantId: "assistant-a"),
            epoch: 1,
            revision: 1
        ))

        let freshCoordinator = makeCoordinator(writer: writer) { content, _, _ in content }
        let acceptedAfterRestart = await freshCoordinator.prepare(preparedUpdate(
            for: overflow,
            epoch: 1,
            revision: 0
        ))

        XCTAssertFalse(rejectedPrepare)
        XCTAssertFalse(rejectedReset)
        XCTAssertTrue(retainedScope)
        XCTAssertTrue(acceptedAfterRestart)
    }

    private func makeCoordinator(
        clock: any LocalNotificationClock = ContinuousLocalNotificationClock(),
        preparedIdentityLimit: Int = LocalNotificationCoordinator<TestContent>
            .defaultPreparedIdentityLimit,
        completedResultLimit: Int = LocalNotificationCoordinator<TestContent>
            .defaultCompletedResultLimit,
        writer: WriteRecorder,
        preparer: @escaping LocalNotificationCoordinator<TestContent>.ContentPreparer
    ) -> LocalNotificationCoordinator<TestContent> {
        LocalNotificationCoordinator(
            clock: clock,
            preparationDeadline: .seconds(30),
            preparedIdentityLimit: preparedIdentityLimit,
            completedResultLimit: completedResultLimit,
            contentPreparer: preparer,
            notificationWriter: { id, content in
                await writer.write(id: id, content: content)
            }
        )
    }

    private func request(
        key: String,
        presentation: LocalNotificationPresentation = .assistant,
        senderName: String? = nil,
        provenance: LocalNotificationNameProvenance? = .identityStore,
        suppressGroupTitle: Bool = false,
        inlineSender: LocalNotificationSender? = nil,
        inlineSenderInvalid: Bool = false,
        identity: LocalNotificationIdentity? = nil
    ) -> LocalNotificationPostRequest<TestContent> {
        LocalNotificationPostRequest(
            deliveryKey: key,
            notificationId: 41,
            plainContent: TestContent(
                title: "Conversation",
                body: "Body",
                senderName: nil,
                groupTitle: nil
            ),
            presentation: presentation,
            identity: identity ?? self.identity,
            senderName: senderName,
            nameProvenance: provenance,
            suppressGroupTitle: suppressGroupTitle,
            inlineSender: inlineSender,
            inlineSenderInvalid: inlineSenderInvalid
        )
    }

    private func sender() -> LocalNotificationSender {
        LocalNotificationSender(id: identity.nativeSenderId, name: "Assistant", avatar: avatar)
    }

    private func preparedUpdate(
        epoch: Int,
        revision: Int
    ) -> LocalNotificationPreparedIdentityUpdate {
        preparedUpdate(for: identity, epoch: epoch, revision: revision)
    }

    private func preparedUpdate(
        for identity: LocalNotificationIdentity,
        epoch: Int,
        revision: Int
    ) -> LocalNotificationPreparedIdentityUpdate {
        LocalNotificationPreparedIdentityUpdate(
            identity: identity,
            scopeEpoch: epoch,
            identityRevision: revision,
            name: "Assistant",
            avatar: avatar
        )
    }

    private func makeIdentity(
        scopeId: String,
        assistantId: String
    ) -> LocalNotificationIdentity {
        LocalNotificationIdentity(
            scopeId: scopeId,
            assistantId: assistantId,
            nativeSenderId: "native-\(scopeId)-\(assistantId)"
        )
    }

    private func waitUntilWaiting<Value>(_ gate: AsyncGate<Value>) async {
        for _ in 0..<1_000 {
            if await gate.isWaiting {
                return
            }
            await Task.yield()
        }
        XCTFail("Gate did not receive a waiter")
    }

    private func waitUntilWaiting(_ clock: ManualClock) async {
        for _ in 0..<1_000 {
            if await clock.isWaiting {
                return
            }
            await Task.yield()
        }
        XCTFail("Clock did not receive a waiter")
    }

    private func waitUntilWriterStarted(_ writer: WriteRecorder) async {
        for _ in 0..<1_000 {
            if await writer.count() > 0 {
                return
            }
            await Task.yield()
        }
        XCTFail("Writer did not start")
    }

    private func png(width: Int, height: Int) throws -> Data {
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let context = try XCTUnwrap(CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        let image = try XCTUnwrap(context.makeImage())
        let data = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(
            data,
            "public.png" as CFString,
            1,
            nil
        ))
        CGImageDestinationAddImage(destination, image, nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return data as Data
    }
}

private actor WriteRecorder {
    private var writes: [(id: Int, content: LocalNotificationCoordinatorTests.TestContent)] = []
    private let result: LocalNotificationDeliveryResult?
    private let resultGate: AsyncGate<LocalNotificationDeliveryResult>?

    init(result: LocalNotificationDeliveryResult) {
        self.result = result
        resultGate = nil
    }

    init(resultGate: AsyncGate<LocalNotificationDeliveryResult>) {
        result = nil
        self.resultGate = resultGate
    }

    func write(
        id: Int,
        content: LocalNotificationCoordinatorTests.TestContent
    ) async -> LocalNotificationDeliveryResult {
        writes.append((id, content))
        if let result {
            return result
        }
        return await resultGate!.wait()
    }

    func snapshot() -> [(id: Int, content: LocalNotificationCoordinatorTests.TestContent)] {
        writes
    }

    func count() -> Int {
        writes.count
    }
}

private actor AsyncGate<Value: Sendable> {
    private var continuation: CheckedContinuation<Value, Never>?
    private var resolved: Value?

    var isWaiting: Bool {
        continuation != nil
    }

    func wait() async -> Value {
        await withCheckedContinuation { continuation in
            if let resolved {
                self.resolved = nil
                continuation.resume(returning: resolved)
                return
            }
            self.continuation = continuation
        }
    }

    func open(_ value: Value) {
        if let continuation {
            self.continuation = nil
            continuation.resume(returning: value)
            return
        }
        resolved = value
    }
}

private actor ManualClock: LocalNotificationClock {
    private var continuation: CheckedContinuation<Void, Never>?

    var isWaiting: Bool {
        continuation != nil
    }

    func sleep(for duration: Duration) async {
        await withCheckedContinuation { continuation in
            self.continuation = continuation
        }
    }

    func fire() {
        let continuation = continuation
        self.continuation = nil
        continuation?.resume()
    }
}
