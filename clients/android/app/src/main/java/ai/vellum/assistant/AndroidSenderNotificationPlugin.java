package ai.vellum.assistant;

import ai.vellum.assistant.push.AvatarCache;
import ai.vellum.assistant.push.NativePushRenderer;
import ai.vellum.assistant.push.NotificationDeliveryCoordinator;
import ai.vellum.assistant.push.PushDataMessage;
import android.graphics.Bitmap;
import androidx.annotation.Nullable;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Collections;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONObject;

/**
 * Process-local Capacitor owner for app-originated Android notifications.
 * The bridge exposes capability discovery, scoped identity prepare/reset,
 * coordinator-owned post, and delivery status. It does not register a
 * foreground notification owner or replace an existing Capacitor plugin.
 */
@CapacitorPlugin(name = "AndroidSenderNotification")
public class AndroidSenderNotificationPlugin extends Plugin {
    static final int IDENTITY_MAX_CHARACTERS = 512;
    static final int SENDER_NAME_MAX_CHARACTERS = 256;
    private static final int PREPARED_IDENTITY_LIMIT = 8;
    private static final int SCOPE_LIMIT = 16;
    private static final int IDENTITY_GUARD_LIMIT = 16;
    private static final AtomicInteger PREPARATION_THREAD_INDEX = new AtomicInteger();
    private static final ExecutorService PREPARATION_EXECUTOR = Executors.newFixedThreadPool(
        2,
        runnable -> {
            Thread thread = new Thread(
                runnable,
                "sender-notification-preparation-" + PREPARATION_THREAD_INDEX.incrementAndGet()
            );
            thread.setDaemon(true);
            return thread;
        }
    );
    private static final PreparedIdentityStore<Bitmap> IDENTITIES =
        new PreparedIdentityStore<>(
            PREPARED_IDENTITY_LIMIT,
            SCOPE_LIMIT,
            IDENTITY_GUARD_LIMIT
        );
    private static final DeliveryOwner<Bitmap> DELIVERY_OWNER = new DeliveryOwner<>() {
        @Override
        public CompletableFuture<NotificationDeliveryCoordinator.DeliveryResult> deliver(
            String deliveryKey,
            int notificationId,
            NotificationDeliveryCoordinator.AvatarPreparation<ResolvedSender<Bitmap>> preparation,
            NotificationDeliveryCoordinator.NotificationWriter<ResolvedSender<Bitmap>> writer
        ) {
            return NotificationDeliveryCoordinator.shared().deliver(
                deliveryKey,
                notificationId,
                preparation,
                writer
            );
        }

        @Override
        public CompletableFuture<NotificationDeliveryCoordinator.DeliveryResult> status(
            String deliveryKey
        ) {
            return NotificationDeliveryCoordinator.shared().status(deliveryKey);
        }
    };

    @PluginMethod
    public void getCapabilities(PluginCall call) {
        call.resolve(capabilitiesPayload());
    }

    @PluginMethod
    public void prepare(PluginCall call) {
        Identity identity = identity(call.getObject("identity"));
        Integer scopeEpoch = call.getInt("scopeEpoch");
        Integer identityRevision = call.getInt("identityRevision");
        if (
            identity == null
                || scopeEpoch == null
                || scopeEpoch < 0
                || identityRevision == null
                || identityRevision < 0
        ) {
            call.resolve(okResult(false));
            return;
        }

        String name = preparedName(
            call.getString("name"),
            call.getString("nameProvenance")
        );
        AvatarSpec avatarSpec = avatarSpec(call.getObject("avatar"));
        Bitmap avatar = avatarSpec == null
            ? null
            : NativeFailureGuard.getAllocating(
                "Unable to decode an Android notification avatar",
                () -> new AvatarCache(getContext()).decodeInline(
                    avatarSpec.base64,
                    avatarSpec.hash
                ),
                null
            );
        if (name == null && avatar == null) {
            call.resolve(okResult(false));
            return;
        }
        boolean accepted = IDENTITIES.prepare(
            new PreparedUpdate<>(
                identity,
                scopeEpoch,
                identityRevision,
                name,
                avatar,
                avatarSpec == null ? null : avatarSpec.hash
            )
        );
        call.resolve(okResult(accepted));
    }

    @PluginMethod
    public void reset(PluginCall call) {
        String scopeId = identityString(call.getString("scopeId"));
        Integer scopeEpoch = call.getInt("scopeEpoch");
        if (scopeId == null || scopeEpoch == null || scopeEpoch < 0) {
            call.resolve(okResult(false));
            return;
        }

        boolean hasAssistant = call.getData().has("assistantId");
        String assistantId = hasAssistant
            ? identityString(call.getString("assistantId"))
            : null;
        boolean hasRevision = call.getData().has("identityRevision");
        Integer identityRevision = hasRevision ? call.getInt("identityRevision") : null;
        if (
            hasAssistant && assistantId == null
                || hasRevision && (identityRevision == null || identityRevision < 0)
                || hasRevision && !hasAssistant
        ) {
            call.resolve(okResult(false));
            return;
        }
        call.resolve(
            okResult(IDENTITIES.reset(scopeId, scopeEpoch, assistantId, identityRevision))
        );
    }

    @PluginMethod
    public void post(PluginCall call) {
        String deliveryKey = deliveryKey(
            call.getString("correlationId"),
            call.getString("deliveryId"),
            call.getString("requestKey")
        );
        if (deliveryKey == null) {
            call.resolve(
                resultObject(
                    NotificationDeliveryCoordinator.DeliveryResult.failed(
                        false,
                        "missing_delivery_key"
                    )
                )
            );
            return;
        }
        Integer notificationId = call.getInt("id");
        String title = call.getString("title");
        String body = call.getString("body");
        if (notificationId == null || title == null || body == null) {
            call.resolve(
                resultObject(
                    NotificationDeliveryCoordinator.DeliveryResult.failed(
                        false,
                        "invalid_notification_content"
                    )
                )
            );
            return;
        }

        PostRequest request = postRequest(call, deliveryKey, notificationId, title, body);
        DeliveryEngine<Bitmap> engine = new DeliveryEngine<>(
            IDENTITIES,
            DELIVERY_OWNER,
            PREPARATION_EXECUTOR,
            spec -> NativeFailureGuard.getAllocating(
                "Unable to decode an Android notification avatar",
                () -> new AvatarCache(getContext()).decodeInline(spec.base64, spec.hash),
                null
            ),
            value -> NativePushRenderer.postBlockReason(getContext(), value.message.channelId),
            (value, sender) -> {
                try {
                    NativePushRenderer.show(
                        getContext(),
                        value.data,
                        value.message.tapMessageId(),
                        value.message,
                        sender == null ? null : sender.avatar,
                        value.notificationId,
                        sender != null && value.suppressGroupTitle,
                        value.actionTypeId,
                        sender == null ? null : sender.id,
                        sender == null ? null : sender.name
                    );
                } catch (SecurityException exception) {
                    return NotificationDeliveryCoordinator.DeliveryResult.blocked(
                        "authorization_denied"
                    );
                }
                return NotificationDeliveryCoordinator.DeliveryResult.posted();
            }
        );
        resolveAsync(call, engine.post(request));
    }

    @PluginMethod
    public void status(PluginCall call) {
        String key = deliveryKey(
            call.getString("correlationId"),
            call.getString("deliveryId"),
            call.getString("requestKey")
        );
        if (key == null) {
            call.resolve(
                resultObject(
                    NotificationDeliveryCoordinator.DeliveryResult.unavailable(
                        "missing_delivery_key"
                    )
                )
            );
            return;
        }
        resolveAsync(call, DELIVERY_OWNER.status(key));
    }

    static JSObject capabilitiesPayload() {
        return new JSObject()
            .put("version", 1)
            .put(
                "capabilities",
                new JSArray()
                    .put("preparedIdentity")
                    .put("singlePostOwner")
                    .put("deliveryStatus")
            );
    }

    private static JSObject okResult(boolean ok) {
        return new JSObject().put("ok", ok);
    }

    static JSObject resultObject(NotificationDeliveryCoordinator.DeliveryResult result) {
        JSObject object = new JSObject().put("status", result.status.name().toLowerCase());
        switch (result.status) {
            case BLOCKED:
            case UNAVAILABLE:
                putIfPresent(object, "reason", result.reason);
                break;
            case FAILED:
                object.put("postingMayHaveBegun", result.postingMayHaveBegun);
                putIfPresent(object, "errorMessage", result.error);
                break;
            case UNKNOWN:
                putIfPresent(
                    object,
                    "errorMessage",
                    result.error == null ? result.reason : result.error
                );
                break;
            case POSTED:
            case DUPLICATE:
                break;
        }
        return object;
    }

    private static void putIfPresent(JSObject object, String key, @Nullable String value) {
        if (value != null && !value.isEmpty()) {
            object.put(key, value);
        }
    }

    private static void resolveAsync(
        PluginCall call,
        CompletableFuture<NotificationDeliveryCoordinator.DeliveryResult> future
    ) {
        future.whenComplete((result, exception) -> {
            if (exception != null) {
                call.resolve(
                    resultObject(
                        NotificationDeliveryCoordinator.DeliveryResult.unknown(
                            false,
                            null,
                            exception.getClass().getSimpleName()
                        )
                    )
                );
                return;
            }
            call.resolve(resultObject(result));
        });
    }

    static PostRequest postRequest(
        PluginCall call,
        String deliveryKey,
        int notificationId,
        String title,
        String body
    ) {
        String presentation = "assistant".equals(call.getString("presentation"))
            ? "assistant"
            : "app";
        Identity identity = identity(call.getObject("identity"));
        String provenance = nameProvenance(call.getString("nameProvenance"));
        String explicitName = senderName(
            firstPresent(call.getString("name"), call.getString("senderName"))
        );
        String selectedName = "assistant".equals(presentation)
            ? explicitName == null && "title".equals(provenance)
                ? senderName(title)
                : explicitName
            : null;
        InlineSender inlineSender = inlineSender(call);
        String deliveryId = identityString(call.getString("deliveryId"));
        String correlationId = identityString(call.getString("correlationId"));
        String requestKey = identityString(call.getString("requestKey"));
        Map<String, String> data = notificationData(call, title, body);
        PushDataMessage message = PushDataMessage.fromLocalData(
            data,
            correlationId,
            deliveryId,
            requestKey
        );
        return new PostRequest(
            deliveryKey,
            notificationId,
            message,
            data,
            call.getString("actionTypeId"),
            presentation,
            identity,
            selectedName,
            provenance,
            Boolean.TRUE.equals(call.getBoolean("suppressGroupTitle", false))
                && "title".equals(provenance),
            inlineSender
        );
    }

    private static Map<String, String> notificationData(
        PluginCall call,
        String title,
        String body
    ) {
        Map<String, String> data = new LinkedHashMap<>();
        JSObject extra = call.getObject("extra");
        if (extra != null) {
            Iterator<String> keys = extra.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                Object value = extra.opt(key);
                if (value != null && value != JSONObject.NULL) {
                    data.put(key, value instanceof String ? (String) value : value.toString());
                }
            }
        }
        putTrimmed(data, "title", title);
        putTrimmed(data, "body", body);
        putTrimmed(data, "channel_id", call.getString("channelId"));
        putTrimmed(data, "delivery_id", call.getString("deliveryId"));
        putTrimmed(data, "conversationId", call.getString("conversationId"));
        putTrimmed(data, "toolCallId", call.getString("toolCallId"));
        putTrimmed(data, "category", call.getString("category"));
        JSObject deepLinkMetadata = call.getObject("deepLinkMetadata");
        if (deepLinkMetadata != null) {
            data.put("deepLinkMetadata", deepLinkMetadata.toString());
        }
        return Collections.unmodifiableMap(data);
    }

    private static void putTrimmed(Map<String, String> data, String key, @Nullable String value) {
        String trimmed = value == null ? null : value.trim();
        if (trimmed != null && !trimmed.isEmpty()) {
            data.put(key, trimmed);
        }
    }

    @Nullable
    static String deliveryKey(
        @Nullable String correlationId,
        @Nullable String deliveryId,
        @Nullable String requestKey
    ) {
        for (String candidate : new String[] { correlationId, deliveryId, requestKey }) {
            String value = identityString(candidate);
            if (value != null) {
                return value;
            }
        }
        return null;
    }

    @Nullable
    static String preparedName(@Nullable String name, @Nullable String provenance) {
        String resolvedProvenance = nameProvenance(provenance);
        return resolvedProvenance == null || "title".equals(resolvedProvenance)
            ? null
            : senderName(name);
    }

    @Nullable
    static String identityString(@Nullable String value) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        return trimmed.isEmpty() || trimmed.length() > IDENTITY_MAX_CHARACTERS
            ? null
            : trimmed;
    }

    @Nullable
    static String senderName(@Nullable String value) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        return trimmed.isEmpty() || trimmed.length() > SENDER_NAME_MAX_CHARACTERS
            ? null
            : trimmed;
    }

    @Nullable
    private static String nameProvenance(@Nullable String value) {
        if (
            "event".equals(value)
                || "identity-store".equals(value)
                || "verified-memory".equals(value)
                || "title".equals(value)
        ) {
            return value;
        }
        return null;
    }

    @Nullable
    private static String firstPresent(@Nullable String first, @Nullable String second) {
        return first == null ? second : first;
    }

    @Nullable
    private static Identity identity(@Nullable JSObject object) {
        if (object == null) {
            return null;
        }
        String scopeId = identityString(object.getString("scopeId"));
        String assistantId = identityString(object.getString("assistantId"));
        String nativeSenderId = identityString(object.getString("nativeSenderId"));
        return scopeId == null || assistantId == null || nativeSenderId == null
            ? null
            : new Identity(scopeId, assistantId, nativeSenderId);
    }

    @Nullable
    private static AvatarSpec avatarSpec(@Nullable JSObject object) {
        if (object == null) {
            return null;
        }
        String base64 = object.getString("avatarBase64");
        String hash = object.getString("avatarHash");
        return base64 == null || hash == null ? null : new AvatarSpec(base64, hash);
    }

    private static InlineSender inlineSender(PluginCall call) {
        if (!call.getData().has("sender")) {
            return InlineSender.absent();
        }
        JSObject object = call.getObject("sender");
        if (object == null) {
            return InlineSender.invalid();
        }
        String id = identityString(object.getString("id"));
        String name = senderName(object.getString("name"));
        AvatarSpec avatar = avatarSpec(object);
        if (id == null || name == null || avatar == null) {
            return InlineSender.invalid();
        }
        return InlineSender.valid(id, name, avatar);
    }

    static final class Identity {
        final String scopeId;
        final String assistantId;
        final String nativeSenderId;

        Identity(String scopeId, String assistantId, String nativeSenderId) {
            this.scopeId = scopeId;
            this.assistantId = assistantId;
            this.nativeSenderId = nativeSenderId;
        }

        @Override
        public boolean equals(Object value) {
            if (!(value instanceof Identity)) {
                return false;
            }
            Identity other = (Identity) value;
            return scopeId.equals(other.scopeId)
                && assistantId.equals(other.assistantId)
                && nativeSenderId.equals(other.nativeSenderId);
        }

        @Override
        public int hashCode() {
            return Objects.hash(scopeId, assistantId, nativeSenderId);
        }
    }

    static final class AvatarSpec {
        final String base64;
        final String hash;

        AvatarSpec(String base64, String hash) {
            this.base64 = base64;
            this.hash = hash;
        }
    }

    static final class InlineSender {
        final boolean supplied;
        final boolean valid;
        @Nullable
        final String id;
        @Nullable
        final String name;
        @Nullable
        final AvatarSpec avatar;

        private InlineSender(
            boolean supplied,
            boolean valid,
            @Nullable String id,
            @Nullable String name,
            @Nullable AvatarSpec avatar
        ) {
            this.supplied = supplied;
            this.valid = valid;
            this.id = id;
            this.name = name;
            this.avatar = avatar;
        }

        static InlineSender absent() {
            return new InlineSender(false, false, null, null, null);
        }

        static InlineSender invalid() {
            return new InlineSender(true, false, null, null, null);
        }

        static InlineSender valid(String id, String name, AvatarSpec avatar) {
            return new InlineSender(true, true, id, name, avatar);
        }
    }

    static final class PreparedUpdate<A> {
        final Identity identity;
        final int scopeEpoch;
        final int identityRevision;
        @Nullable
        final String name;
        @Nullable
        final A avatar;
        @Nullable
        final String avatarHash;

        PreparedUpdate(
            Identity identity,
            int scopeEpoch,
            int identityRevision,
            @Nullable String name,
            @Nullable A avatar,
            @Nullable String avatarHash
        ) {
            this.identity = identity;
            this.scopeEpoch = scopeEpoch;
            this.identityRevision = identityRevision;
            this.name = name;
            this.avatar = avatar;
            this.avatarHash = avatarHash;
        }
    }

    static final class ResolvedSender<A> {
        final String id;
        final String name;
        final A avatar;
        final String avatarHash;

        ResolvedSender(String id, String name, A avatar, String avatarHash) {
            this.id = id;
            this.name = name;
            this.avatar = avatar;
            this.avatarHash = avatarHash;
        }
    }

    static final class PostRequest {
        final String deliveryKey;
        final int notificationId;
        final PushDataMessage message;
        final Map<String, String> data;
        @Nullable
        final String actionTypeId;
        final String presentation;
        @Nullable
        final Identity identity;
        @Nullable
        final String senderName;
        @Nullable
        final String nameProvenance;
        final boolean suppressGroupTitle;
        final InlineSender inlineSender;

        PostRequest(
            String deliveryKey,
            int notificationId,
            PushDataMessage message,
            Map<String, String> data,
            @Nullable String actionTypeId,
            String presentation,
            @Nullable Identity identity,
            @Nullable String senderName,
            @Nullable String nameProvenance,
            boolean suppressGroupTitle,
            InlineSender inlineSender
        ) {
            this.deliveryKey = deliveryKey;
            this.notificationId = notificationId;
            this.message = message;
            this.data = data;
            this.actionTypeId = actionTypeId;
            this.presentation = presentation;
            this.identity = identity;
            this.senderName = senderName;
            this.nameProvenance = nameProvenance;
            this.suppressGroupTitle = suppressGroupTitle;
            this.inlineSender = inlineSender;
        }
    }

    @FunctionalInterface
    interface AvatarDecoder<A> {
        @Nullable
        A decode(AvatarSpec spec);
    }

    @FunctionalInterface
    interface PostingPolicy {
        @Nullable
        String blockReason(PostRequest request);
    }

    @FunctionalInterface
    interface NotificationPoster<A> {
        NotificationDeliveryCoordinator.DeliveryResult post(
            PostRequest request,
            @Nullable ResolvedSender<A> sender
        );
    }

    interface DeliveryOwner<A> {
        CompletableFuture<NotificationDeliveryCoordinator.DeliveryResult> deliver(
            String deliveryKey,
            int notificationId,
            NotificationDeliveryCoordinator.AvatarPreparation<ResolvedSender<A>> preparation,
            NotificationDeliveryCoordinator.NotificationWriter<ResolvedSender<A>> writer
        );

        CompletableFuture<NotificationDeliveryCoordinator.DeliveryResult> status(
            String deliveryKey
        );
    }

    static final class DeliveryEngine<A> {
        private final PreparedIdentityStore<A> identities;
        private final DeliveryOwner<A> owner;
        private final Executor preparationExecutor;
        private final AvatarDecoder<A> avatarDecoder;
        private final PostingPolicy postingPolicy;
        private final NotificationPoster<A> poster;

        DeliveryEngine(
            PreparedIdentityStore<A> identities,
            DeliveryOwner<A> owner,
            Executor preparationExecutor,
            AvatarDecoder<A> avatarDecoder,
            PostingPolicy postingPolicy,
            NotificationPoster<A> poster
        ) {
            this.identities = identities;
            this.owner = owner;
            this.preparationExecutor = preparationExecutor;
            this.avatarDecoder = avatarDecoder;
            this.postingPolicy = postingPolicy;
            this.poster = poster;
        }

        CompletableFuture<NotificationDeliveryCoordinator.DeliveryResult> post(
            PostRequest request
        ) {
            return owner.deliver(
                request.deliveryKey,
                request.notificationId,
                () -> CompletableFuture.supplyAsync(
                    () -> {
                        if (postingPolicy.blockReason(request) != null) {
                            return null;
                        }
                        return identities.sender(request, avatarDecoder);
                    },
                    preparationExecutor
                ),
                (notificationId, sender) -> {
                    final String blockReason;
                    try {
                        blockReason = postingPolicy.blockReason(request);
                    } catch (RuntimeException exception) {
                        return NotificationDeliveryCoordinator.DeliveryResult.unknown(
                            false,
                            null,
                            exception.getClass().getSimpleName()
                        );
                    }
                    if (blockReason != null) {
                        return NotificationDeliveryCoordinator.DeliveryResult.blocked(
                            blockReason
                        );
                    }
                    return poster.post(request, sender);
                }
            );
        }
    }

    static final class PreparedIdentityStore<A> {
        private final int preparedLimit;
        private final int scopeLimit;
        private final int generationLimit;
        private final Map<String, ScopeState> scopes = new HashMap<>();
        private final LinkedHashMap<IdentityKey, PreparedIdentity<A>> prepared =
            new LinkedHashMap<>(16, 0.75f, true);
        private final LinkedHashMap<IdentityKey, Generation> generations =
            new LinkedHashMap<>(16, 0.75f, true);

        PreparedIdentityStore(int preparedLimit, int scopeLimit, int generationLimit) {
            if (preparedLimit <= 0 || scopeLimit <= 0 || generationLimit <= 0) {
                throw new IllegalArgumentException("Identity store limits must be positive");
            }
            this.preparedLimit = preparedLimit;
            this.scopeLimit = scopeLimit;
            this.generationLimit = generationLimit;
        }

        synchronized boolean prepare(PreparedUpdate<A> update) {
            if (update.scopeEpoch < 0 || update.identityRevision < 0) {
                return false;
            }
            ScopeState scope = acceptScope(update.identity.scopeId, update.scopeEpoch);
            if (scope == null || scope.sealed) {
                return false;
            }
            IdentityKey key = new IdentityKey(
                update.identity.scopeId,
                update.identity.assistantId
            );
            Generation generation = generations.get(key);
            if (generation != null) {
                if (update.scopeEpoch < generation.scopeEpoch) {
                    return false;
                }
                if (update.scopeEpoch == generation.scopeEpoch) {
                    boolean stale = generation.tombstone
                        ? update.identityRevision <= generation.identityRevision
                        : update.identityRevision < generation.identityRevision;
                    if (stale) {
                        return false;
                    }
                }
            }
            if (!ensureGenerationSlot(key)) {
                return false;
            }

            PreparedIdentity<A> existing = prepared.get(key);
            if (existing != null && update.identityRevision < existing.revision) {
                return false;
            }
            boolean sameOwner = existing != null && existing.identity.equals(update.identity);
            String name = update.name != null
                ? update.name
                : sameOwner ? existing.name : null;
            A avatar = update.avatar != null
                ? update.avatar
                : sameOwner ? existing.avatar : null;
            String avatarHash = update.avatar != null
                ? update.avatarHash
                : sameOwner ? existing.avatarHash : null;
            if (name == null && avatar == null) {
                return false;
            }
            prepared.put(
                key,
                new PreparedIdentity<>(
                    update.identity,
                    update.identityRevision,
                    name,
                    avatar,
                    avatarHash
                )
            );
            generations.put(
                key,
                new Generation(update.scopeEpoch, update.identityRevision, false)
            );
            prunePrepared();
            return true;
        }

        synchronized boolean reset(
            String scopeId,
            int scopeEpoch,
            @Nullable String assistantId,
            @Nullable Integer identityRevision
        ) {
            if (
                scopeEpoch < 0
                    || identityRevision != null && assistantId == null
                    || identityRevision != null && identityRevision < 0
            ) {
                return false;
            }
            ScopeState currentScope = scopes.get(scopeId);
            if (
                currentScope != null
                    && currentScope.sealed
                    && scopeEpoch == currentScope.epoch
            ) {
                return true;
            }
            ScopeState scope = acceptScope(scopeId, scopeEpoch);
            if (scope == null || scope.sealed) {
                return false;
            }
            if (assistantId == null) {
                clearIdentityState(scopeId);
                scope.sealed = true;
                return true;
            }

            IdentityKey key = new IdentityKey(scopeId, assistantId);
            Generation known = generations.get(key);
            if (
                identityRevision != null
                    && known != null
                    && known.scopeEpoch == scopeEpoch
                    && identityRevision < known.identityRevision
            ) {
                return false;
            }
            int tombstoneRevision = identityRevision == null
                ? known == null || known.scopeEpoch != scopeEpoch
                    ? -1
                    : known.identityRevision
                : identityRevision;
            if (!ensureGenerationSlot(key)) {
                return scopes.get(scopeId).sealed;
            }
            prepared.remove(key);
            generations.put(
                key,
                new Generation(scopeEpoch, tombstoneRevision, true)
            );
            return true;
        }

        @Nullable
        ResolvedSender<A> sender(
            PostRequest request,
            AvatarDecoder<A> avatarDecoder
        ) {
            if (!"assistant".equals(request.presentation) || request.identity == null) {
                return null;
            }
            InlineSender inline = request.inlineSender;
            if (inline.supplied) {
                if (
                    !inline.valid
                        || !request.identity.nativeSenderId.equals(inline.id)
                        || inline.avatar == null
                        || inline.name == null
                ) {
                    return null;
                }
                A avatar = avatarDecoder.decode(inline.avatar);
                return avatar == null
                    ? null
                    : new ResolvedSender<>(
                        inline.id,
                        inline.name,
                        avatar,
                        inline.avatar.hash
                    );
            }
            synchronized (this) {
                IdentityKey key = new IdentityKey(
                    request.identity.scopeId,
                    request.identity.assistantId
                );
                PreparedIdentity<A> snapshot = prepared.get(key);
                if (
                    snapshot == null
                        || !snapshot.identity.equals(request.identity)
                        || snapshot.avatar == null
                        || snapshot.avatarHash == null
                ) {
                    return null;
                }
                String name = request.senderName == null ? snapshot.name : request.senderName;
                return name == null
                    ? null
                    : new ResolvedSender<>(
                        request.identity.nativeSenderId,
                        name,
                        snapshot.avatar,
                        snapshot.avatarHash
                    );
            }
        }

        private ScopeState acceptScope(String scopeId, int epoch) {
            ScopeState state = scopes.get(scopeId);
            if (state == null) {
                if (scopes.size() >= scopeLimit) {
                    return null;
                }
                state = new ScopeState(epoch, false);
                scopes.put(scopeId, state);
                return state;
            }
            if (epoch < state.epoch || state.sealed && epoch <= state.epoch) {
                return null;
            }
            if (epoch > state.epoch) {
                clearIdentityState(scopeId);
                state.epoch = epoch;
                state.sealed = false;
            }
            return state;
        }

        private boolean ensureGenerationSlot(IdentityKey requested) {
            if (generations.containsKey(requested)) {
                return true;
            }
            if (generations.size() < generationLimit) {
                return true;
            }
            IdentityKey eldest = generations.keySet().iterator().next();
            sealScope(eldest.scopeId);
            ScopeState requestedScope = scopes.get(requested.scopeId);
            return requestedScope != null
                && !requestedScope.sealed
                && generations.size() < generationLimit;
        }

        private void sealScope(String scopeId) {
            ScopeState state = scopes.get(scopeId);
            if (state != null) {
                state.sealed = true;
            }
            clearIdentityState(scopeId);
        }

        private void clearIdentityState(String scopeId) {
            prepared.keySet().removeIf(key -> key.scopeId.equals(scopeId));
            generations.keySet().removeIf(key -> key.scopeId.equals(scopeId));
        }

        private void prunePrepared() {
            while (prepared.size() > preparedLimit) {
                IdentityKey eldest = prepared.keySet().iterator().next();
                prepared.remove(eldest);
            }
        }

        synchronized int preparedCount() {
            return prepared.size();
        }

        synchronized int scopeCount() {
            return scopes.size();
        }

        synchronized int generationCount() {
            return generations.size();
        }

        synchronized boolean isScopeSealed(String scopeId) {
            ScopeState state = scopes.get(scopeId);
            return state != null && state.sealed;
        }
    }

    private static final class ScopeState {
        int epoch;
        boolean sealed;

        ScopeState(int epoch, boolean sealed) {
            this.epoch = epoch;
            this.sealed = sealed;
        }
    }

    private static final class IdentityKey {
        final String scopeId;
        final String assistantId;

        IdentityKey(String scopeId, String assistantId) {
            this.scopeId = scopeId;
            this.assistantId = assistantId;
        }

        @Override
        public boolean equals(Object value) {
            if (!(value instanceof IdentityKey)) {
                return false;
            }
            IdentityKey other = (IdentityKey) value;
            return scopeId.equals(other.scopeId) && assistantId.equals(other.assistantId);
        }

        @Override
        public int hashCode() {
            return Objects.hash(scopeId, assistantId);
        }
    }

    private static final class Generation {
        final int scopeEpoch;
        final int identityRevision;
        final boolean tombstone;

        Generation(int scopeEpoch, int identityRevision, boolean tombstone) {
            this.scopeEpoch = scopeEpoch;
            this.identityRevision = identityRevision;
            this.tombstone = tombstone;
        }
    }

    private static final class PreparedIdentity<A> {
        final Identity identity;
        final int revision;
        @Nullable
        final String name;
        @Nullable
        final A avatar;
        @Nullable
        final String avatarHash;

        PreparedIdentity(
            Identity identity,
            int revision,
            @Nullable String name,
            @Nullable A avatar,
            @Nullable String avatarHash
        ) {
            this.identity = identity;
            this.revision = revision;
            this.name = name;
            this.avatar = avatar;
            this.avatarHash = avatarHash;
        }
    }
}
