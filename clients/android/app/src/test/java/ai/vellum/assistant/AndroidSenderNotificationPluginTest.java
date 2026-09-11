package ai.vellum.assistant;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import ai.vellum.assistant.AndroidSenderNotificationPlugin.AvatarSpec;
import ai.vellum.assistant.AndroidSenderNotificationPlugin.DeliveryEngine;
import ai.vellum.assistant.AndroidSenderNotificationPlugin.DeliveryOwner;
import ai.vellum.assistant.AndroidSenderNotificationPlugin.Identity;
import ai.vellum.assistant.AndroidSenderNotificationPlugin.InlineSender;
import ai.vellum.assistant.AndroidSenderNotificationPlugin.PostRequest;
import ai.vellum.assistant.AndroidSenderNotificationPlugin.PreparedIdentityStore;
import ai.vellum.assistant.AndroidSenderNotificationPlugin.PreparedUpdate;
import ai.vellum.assistant.AndroidSenderNotificationPlugin.ResolvedSender;
import ai.vellum.assistant.push.NotificationDeliveryCoordinator;
import ai.vellum.assistant.push.PushDataMessage;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.util.Collections;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;

public class AndroidSenderNotificationPluginTest {
    private static final Identity ALICE = new Identity("scope-1", "assistant-1", "native-1");
    private static final String HASH = "a".repeat(64);

    @Test
    public void advertisesOnlyTheVersionOneAdditiveCapabilities() throws Exception {
        JSObject payload = AndroidSenderNotificationPlugin.capabilitiesPayload();
        JSArray capabilities = (JSArray) payload.opt("capabilities");

        assertEquals(1, payload.getInteger("version").intValue());
        assertEquals(3, capabilities.length());
        assertEquals("preparedIdentity", capabilities.getString(0));
        assertEquals("singlePostOwner", capabilities.getString(1));
        assertEquals("deliveryStatus", capabilities.getString(2));
        assertFalse(payload.has("notificationOwner"));
    }

    @Test
    public void mapsBridgeContentTapIdentityAndNumericIdWithoutHashingTheOwnerKey() {
        JSObject payload = new JSObject()
            .put("id", 73)
            .put("title", "Ready")
            .put("body", "The task finished")
            .put("correlationId", "correlation-1")
            .put("deliveryId", "delivery-1")
            .put("requestKey", "request-1")
            .put("channelId", "vellum-alerts")
            .put("category", "notificationIntent")
            .put("actionTypeId", "notificationIntent")
            .put("conversationId", "conversation-1")
            .put("extra", new JSObject().put("sourceEventName", "activity_complete"));
        PostRequest request = AndroidSenderNotificationPlugin.postRequest(
            new PluginCall(null, "test", "callback", "post", payload),
            "correlation-1",
            73,
            "Ready",
            "The task finished"
        );

        assertEquals("correlation-1", request.deliveryKey);
        assertEquals(73, request.notificationId);
        assertEquals("correlation-1", request.message.tapMessageId());
        assertEquals("conversation-1", request.message.conversationId);
        assertEquals("notificationIntent", request.actionTypeId);
        assertEquals("activity_complete", request.data.get("sourceEventName"));
    }

    @Test
    public void synthesizesTapIdentityOnlyWhenCorrelationAndDeliveryAreAbsent() {
        PushDataMessage message = PushDataMessage.fromLocalData(
            Collections.singletonMap("title", "Ready"),
            null,
            null,
            "request-1"
        );

        assertEquals("request-1", message.deliveryKey());
        assertEquals("vellum-local:request-1", message.tapMessageId());
    }

    @Test
    public void resolvesBoundedDeliveryKeysInContractOrder() {
        assertEquals(
            "correlation-1",
            AndroidSenderNotificationPlugin.deliveryKey(
                " correlation-1 ",
                "delivery-1",
                "request-1"
            )
        );
        assertEquals(
            "delivery-1",
            AndroidSenderNotificationPlugin.deliveryKey(" ", "delivery-1", "request-1")
        );
        assertNull(AndroidSenderNotificationPlugin.deliveryKey(null, null, "x".repeat(513)));
    }

    @Test
    public void neverPreparesATitleDerivedName() {
        assertNull(AndroidSenderNotificationPlugin.preparedName("Alice", "title"));
        assertEquals(
            "Alice",
            AndroidSenderNotificationPlugin.preparedName(" Alice ", "event")
        );
        assertNull(AndroidSenderNotificationPlugin.preparedName("Alice", "unverified"));
        assertNull(AndroidSenderNotificationPlugin.senderName("x".repeat(257)));
    }

    @Test
    public void titleProvenanceIsScopedToOnePostAndSuppressesItsDuplicateGroupTitle() {
        JSObject payload = new JSObject()
            .put("presentation", "assistant")
            .put("deliveryId", "delivery-1")
            .put("nameProvenance", "title")
            .put("suppressGroupTitle", true)
            .put(
                "identity",
                new JSObject()
                    .put("scopeId", "scope-1")
                    .put("assistantId", "assistant-1")
                    .put("nativeSenderId", "native-1")
            );
        PostRequest request = AndroidSenderNotificationPlugin.postRequest(
            new PluginCall(null, "test", "callback", "post", payload),
            "delivery-1",
            43,
            "Alice",
            "The task finished"
        );

        assertEquals("Alice", request.senderName);
        assertEquals("title", request.nameProvenance);
        assertTrue(request.suppressGroupTitle);
        assertNull(AndroidSenderNotificationPlugin.preparedName("Alice", "title"));
    }

    @Test
    public void preparedSenderRequiresExactScopeAssistantAndNativeOwnership() {
        PreparedIdentityStore<String> store = store(8, 16, 16);
        assertTrue(store.prepare(update(ALICE, 1, 1, "Alice", "avatar-1")));

        ResolvedSender<String> resolved = store.sender(
            request(ALICE, "assistant", "Event Alice", InlineSender.absent()),
            spec -> "inline"
        );
        assertEquals("native-1", resolved.id);
        assertEquals("Event Alice", resolved.name);
        assertEquals("avatar-1", resolved.avatar);
        assertNull(
            store.sender(
                request(
                    new Identity("scope-1", "assistant-1", "native-2"),
                    "assistant",
                    "Alice",
                    InlineSender.absent()
                ),
                spec -> "inline"
            )
        );
        assertNull(store.sender(request(ALICE, "app", "Alice", InlineSender.absent()), spec -> "inline"));
    }

    @Test
    public void malformedInlineSenderSuppressesPreparedFallback() {
        PreparedIdentityStore<String> store = store(8, 16, 16);
        assertTrue(store.prepare(update(ALICE, 1, 1, "Alice", "prepared-avatar")));

        assertNull(
            store.sender(
                request(ALICE, "assistant", "Alice", InlineSender.invalid()),
                spec -> "inline-avatar"
            )
        );
        assertNull(
            store.sender(
                request(
                    ALICE,
                    "assistant",
                    "Alice",
                    InlineSender.valid(
                        "native-other",
                        "Alice",
                        new AvatarSpec("encoded", HASH)
                    )
                ),
                spec -> "inline-avatar"
            )
        );
    }

    @Test
    public void inlineDecorationIsUsedOnlyAfterTheDecoderAcceptsIt() {
        PreparedIdentityStore<String> store = store(8, 16, 16);
        InlineSender inline = InlineSender.valid(
            "native-1",
            "Alice",
            new AvatarSpec("encoded", HASH)
        );

        assertNull(store.sender(request(ALICE, "assistant", null, inline), spec -> null));
        ResolvedSender<String> accepted = store.sender(
            request(ALICE, "assistant", null, inline),
            spec -> "inline-avatar"
        );
        assertEquals("Alice", accepted.name);
        assertEquals("inline-avatar", accepted.avatar);
    }

    @Test
    public void preparedSnapshotsAreBoundedWithoutDroppingGenerationGuards() {
        PreparedIdentityStore<String> store = store(1, 4, 4);
        Identity first = new Identity("scope-1", "assistant-1", "native-1");
        Identity second = new Identity("scope-1", "assistant-2", "native-2");

        assertTrue(store.prepare(update(first, 1, 3, "Alice", "avatar-1")));
        assertTrue(store.prepare(update(second, 1, 1, "Bob", "avatar-2")));
        assertEquals(1, store.preparedCount());
        assertEquals(2, store.generationCount());
        assertFalse(store.prepare(update(first, 1, 2, "Stale", "avatar-stale")));
    }

    @Test
    public void fullResetSealsItsEpochAndOnlyAHigherEpochReopensIt() {
        PreparedIdentityStore<String> store = store(8, 4, 8);
        assertTrue(store.prepare(update(ALICE, 4, 1, "Alice", "avatar-1")));
        assertTrue(store.reset("scope-1", 4, null, null));
        assertTrue(store.isScopeSealed("scope-1"));
        assertFalse(store.prepare(update(ALICE, 4, 2, "Stale", "avatar-stale")));
        assertTrue(store.prepare(update(ALICE, 5, 0, "Fresh", "avatar-2")));
        assertFalse(store.isScopeSealed("scope-1"));
    }

    @Test
    public void unknownScopesFailClosedAfterTheFixedAdmissionBudget() {
        PreparedIdentityStore<String> store = store(8, 1, 8);
        assertTrue(store.prepare(update(ALICE, 1, 1, "Alice", "avatar-1")));

        Identity unknown = new Identity("scope-2", "assistant-2", "native-2");
        assertFalse(store.prepare(update(unknown, 100, 1, "Bob", "avatar-2")));
        assertFalse(store.reset("scope-2", 100, null, null));
        assertEquals(1, store.scopeCount());
    }

    @Test
    public void guardPressureSealsTheWholeLruScopeAndHigherEpochReopensIt() {
        PreparedIdentityStore<String> store = store(8, 4, 2);
        Identity first = new Identity("scope-1", "assistant-1", "native-1");
        Identity sibling = new Identity("scope-1", "assistant-2", "native-2");
        Identity other = new Identity("scope-2", "assistant-3", "native-3");
        assertTrue(store.prepare(update(first, 7, 1, "Alice", "avatar-1")));
        assertTrue(store.prepare(update(sibling, 7, 1, "Bob", "avatar-2")));

        assertTrue(store.prepare(update(other, 1, 1, "Carol", "avatar-3")));
        assertTrue(store.isScopeSealed("scope-1"));
        assertEquals(1, store.preparedCount());
        assertEquals(1, store.generationCount());
        assertFalse(store.prepare(update(sibling, 7, 2, "Stale", "avatar-stale")));
        assertTrue(store.prepare(update(sibling, 8, 0, "Fresh", "avatar-fresh")));
    }

    @Test
    public void staleTargetedResetDoesNotDeleteNewerPreparedState() {
        PreparedIdentityStore<String> store = store(8, 4, 8);
        assertTrue(store.prepare(update(ALICE, 2, 5, "Alice", "avatar-5")));

        assertFalse(store.reset("scope-1", 2, "assistant-1", 4));
        ResolvedSender<String> sender = store.sender(
            request(ALICE, "assistant", null, InlineSender.absent()),
            spec -> null
        );
        assertEquals("avatar-5", sender.avatar);
        assertTrue(store.reset("scope-1", 2, "assistant-1", 5));
        assertNull(
            store.sender(
                request(ALICE, "assistant", null, InlineSender.absent()),
                spec -> null
            )
        );
        assertFalse(store.prepare(update(ALICE, 2, 5, "Stale", "avatar-stale")));
    }

    @Test
    public void blockedDeliveryStillClaimsTheCoordinatorAndSkipsAvatarDecode() {
        PreparedIdentityStore<String> store = store(8, 4, 8);
        ImmediateOwner<String> owner = new ImmediateOwner<>();
        AtomicInteger decoded = new AtomicInteger();
        AtomicInteger posted = new AtomicInteger();
        DeliveryEngine<String> engine = new DeliveryEngine<>(
            store,
            owner,
            Runnable::run,
            spec -> {
                decoded.incrementAndGet();
                return "avatar";
            },
            request -> "authorization_denied",
            (request, sender) -> {
                posted.incrementAndGet();
                return NotificationDeliveryCoordinator.DeliveryResult.posted();
            }
        );

        NotificationDeliveryCoordinator.DeliveryResult result = engine
            .post(request(ALICE, "assistant", "Alice", InlineSender.absent()))
            .join();

        assertEquals(1, owner.deliveries);
        assertEquals(43, owner.notificationId);
        assertEquals("delivery-1", owner.deliveryKey);
        assertEquals(NotificationDeliveryCoordinator.DeliveryStatus.BLOCKED, result.status);
        assertEquals("authorization_denied", result.reason);
        assertEquals(0, decoded.get());
        assertEquals(0, posted.get());
    }

    @Test
    public void appPresentationPostsPlainThroughTheCoordinator() {
        PreparedIdentityStore<String> store = store(8, 4, 8);
        assertTrue(store.prepare(update(ALICE, 1, 1, "Alice", "prepared-avatar")));
        ImmediateOwner<String> owner = new ImmediateOwner<>();
        AtomicReference<ResolvedSender<String>> written = new AtomicReference<>();
        DeliveryEngine<String> engine = new DeliveryEngine<>(
            store,
            owner,
            Runnable::run,
            spec -> "inline-avatar",
            request -> null,
            (request, sender) -> {
                written.set(sender);
                return NotificationDeliveryCoordinator.DeliveryResult.posted();
            }
        );

        NotificationDeliveryCoordinator.DeliveryResult result = engine
            .post(request(ALICE, "app", "Alice", InlineSender.absent()))
            .join();

        assertEquals(NotificationDeliveryCoordinator.DeliveryStatus.POSTED, result.status);
        assertNull(written.get());
        assertEquals(1, owner.deliveries);
    }

    @Test
    public void assistantPresentationCarriesTheResolvedIdentityToTheSoleWriter() {
        PreparedIdentityStore<String> store = store(8, 4, 8);
        assertTrue(store.prepare(update(ALICE, 1, 1, "Prepared Alice", "prepared-avatar")));
        ImmediateOwner<String> owner = new ImmediateOwner<>();
        AtomicReference<ResolvedSender<String>> written = new AtomicReference<>();
        DeliveryEngine<String> engine = new DeliveryEngine<>(
            store,
            owner,
            Runnable::run,
            spec -> "inline-avatar",
            request -> null,
            (request, sender) -> {
                written.set(sender);
                return NotificationDeliveryCoordinator.DeliveryResult.posted();
            }
        );

        NotificationDeliveryCoordinator.DeliveryResult result = engine
            .post(request(ALICE, "assistant", "Event Alice", InlineSender.absent()))
            .join();

        assertEquals(NotificationDeliveryCoordinator.DeliveryStatus.POSTED, result.status);
        assertEquals("native-1", written.get().id);
        assertEquals("Event Alice", written.get().name);
        assertEquals("prepared-avatar", written.get().avatar);
        assertEquals(1, owner.deliveries);
    }

    @Test
    public void mapsAllCoordinatorResultsToTheWireContract() {
        assertEquals(
            "posted",
            AndroidSenderNotificationPlugin.resultObject(
                NotificationDeliveryCoordinator.DeliveryResult.posted()
            ).getString("status")
        );
        assertEquals(
            "duplicate",
            AndroidSenderNotificationPlugin.resultObject(
                NotificationDeliveryCoordinator.DeliveryResult.duplicate()
            ).getString("status")
        );
        JSObject blocked = AndroidSenderNotificationPlugin.resultObject(
            NotificationDeliveryCoordinator.DeliveryResult.blocked("channel_disabled")
        );
        assertEquals("channel_disabled", blocked.getString("reason"));
        JSObject failed = AndroidSenderNotificationPlugin.resultObject(
            NotificationDeliveryCoordinator.DeliveryResult.failed(true, "write_failed")
        );
        assertTrue(failed.getBool("postingMayHaveBegun"));
        assertEquals("write_failed", failed.getString("errorMessage"));
        JSObject unknown = AndroidSenderNotificationPlugin.resultObject(
            NotificationDeliveryCoordinator.DeliveryResult.unknown(
                false,
                "delivery_in_flight",
                null
            )
        );
        assertEquals("delivery_in_flight", unknown.getString("errorMessage"));
        JSObject unavailable = AndroidSenderNotificationPlugin.resultObject(
            NotificationDeliveryCoordinator.DeliveryResult.unavailable("delivery_not_found")
        );
        assertEquals("delivery_not_found", unavailable.getString("reason"));
    }

    private static PreparedIdentityStore<String> store(
        int prepared,
        int scopes,
        int generations
    ) {
        return new PreparedIdentityStore<>(prepared, scopes, generations);
    }

    private static PreparedUpdate<String> update(
        Identity identity,
        int epoch,
        int revision,
        String name,
        String avatar
    ) {
        return new PreparedUpdate<>(identity, epoch, revision, name, avatar, HASH);
    }

    private static PostRequest request(
        Identity identity,
        String presentation,
        String name,
        InlineSender inlineSender
    ) {
        PushDataMessage message = PushDataMessage.fromLocalData(
            Collections.singletonMap("title", "Ready"),
            null,
            "delivery-1",
            null
        );
        return new PostRequest(
            "delivery-1",
            43,
            message,
            Collections.singletonMap("title", "Ready"),
            "notificationIntent",
            presentation,
            identity,
            name,
            "event",
            false,
            inlineSender
        );
    }

    private static final class ImmediateOwner<A> implements DeliveryOwner<A> {
        int deliveries;
        int notificationId;
        String deliveryKey;

        @Override
        public CompletableFuture<NotificationDeliveryCoordinator.DeliveryResult> deliver(
            String deliveryKey,
            int notificationId,
            NotificationDeliveryCoordinator.AvatarPreparation<ResolvedSender<A>> preparation,
            NotificationDeliveryCoordinator.NotificationWriter<ResolvedSender<A>> writer
        ) {
            deliveries++;
            this.deliveryKey = deliveryKey;
            this.notificationId = notificationId;
            ResolvedSender<A> sender = preparation.prepare().toCompletableFuture().join();
            return CompletableFuture.completedFuture(writer.post(notificationId, sender));
        }

        @Override
        public CompletableFuture<NotificationDeliveryCoordinator.DeliveryResult> status(
            String deliveryKey
        ) {
            return CompletableFuture.completedFuture(
                NotificationDeliveryCoordinator.DeliveryResult.unavailable("delivery_not_found")
            );
        }
    }
}
