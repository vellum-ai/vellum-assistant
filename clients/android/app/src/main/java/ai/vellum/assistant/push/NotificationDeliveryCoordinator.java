package ai.vellum.assistant.push;

import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Process-local owner for Android notification delivery. Delivery ownership is
 * keyed by the full canonical delivery key. The integer notification id is
 * carried separately to the writer and is never used for duplicate detection.
 */
public final class NotificationDeliveryCoordinator {
    public static final long DEFAULT_AVATAR_DEADLINE_MILLIS = 1_000;
    private static final int DEFAULT_COMPLETED_CAPACITY = 128;

    private static final NotificationDeliveryCoordinator PROCESS_SHARED =
        new NotificationDeliveryCoordinator(new SystemClock(), DEFAULT_COMPLETED_CAPACITY);

    /** Terminal result returned to FCM and local callers. */
    public enum DeliveryStatus {
        POSTED,
        DUPLICATE,
        BLOCKED,
        FAILED,
        UNKNOWN,
        UNAVAILABLE,
    }

    /**
     * A delivery outcome. Reason and error are intended for bounded diagnostic
     * text, not notification content or other payload data.
     */
    public static final class DeliveryResult {
        public final DeliveryStatus status;
        public final boolean postingMayHaveBegun;
        public final String reason;
        public final String error;

        private DeliveryResult(
            DeliveryStatus status,
            boolean postingMayHaveBegun,
            String reason,
            String error
        ) {
            this.status = Objects.requireNonNull(status, "status");
            this.postingMayHaveBegun = postingMayHaveBegun;
            this.reason = reason;
            this.error = error;
        }

        public static DeliveryResult posted() {
            return new DeliveryResult(DeliveryStatus.POSTED, true, null, null);
        }

        public static DeliveryResult duplicate() {
            return new DeliveryResult(DeliveryStatus.DUPLICATE, true, null, null);
        }

        public static DeliveryResult blocked(String reason) {
            return new DeliveryResult(DeliveryStatus.BLOCKED, false, reason, null);
        }

        public static DeliveryResult failed(boolean postingMayHaveBegun, String error) {
            return new DeliveryResult(
                DeliveryStatus.FAILED,
                postingMayHaveBegun,
                null,
                error
            );
        }

        public static DeliveryResult unknown(String reason) {
            return new DeliveryResult(DeliveryStatus.UNKNOWN, true, reason, null);
        }

        public static DeliveryResult unavailable(String reason) {
            return new DeliveryResult(DeliveryStatus.UNAVAILABLE, false, reason, null);
        }

        private DeliveryResult asRetainedResult() {
            return status == DeliveryStatus.POSTED ? duplicate() : this;
        }
    }

    /** A monotonic clock that also owns deadline scheduling. */
    public interface Clock {
        long nowMillis();

        Cancellation schedule(long delayMillis, Runnable task);
    }

    /** Handle for deadline work that has not started. */
    public interface Cancellation {
        void cancel();
    }

    /** Starts non-blocking avatar preparation. Null is a valid plain result. */
    @FunctionalInterface
    public interface AvatarPreparation<A> {
        CompletionStage<A> prepare();
    }

    /**
     * Attempts the sole OS post for a delivery. A null avatar selects the plain
     * notification without changing its content or tap identity.
     */
    @FunctionalInterface
    public interface NotificationWriter<A> {
        DeliveryResult post(int notificationId, A avatar);
    }

    private static final class InFlight {
        final CompletableFuture<DeliveryResult> result = new CompletableFuture<>();
    }

    private final Object ownershipLock = new Object();
    private final Clock clock;
    private final int completedCapacity;
    private final Map<String, InFlight> inFlight = new HashMap<>();
    private final LinkedHashMap<String, DeliveryResult> completed = new LinkedHashMap<>(
        16,
        0.75f,
        true
    );

    /** The owner shared by every bridge and Firebase caller in this process. */
    public static NotificationDeliveryCoordinator shared() {
        return PROCESS_SHARED;
    }

    NotificationDeliveryCoordinator(Clock clock, int completedCapacity) {
        this.clock = Objects.requireNonNull(clock, "clock");
        if (completedCapacity <= 0) {
            throw new IllegalArgumentException("completedCapacity must be positive");
        }
        this.completedCapacity = completedCapacity;
    }

    public <A> CompletableFuture<DeliveryResult> deliver(
        String deliveryKey,
        int notificationId,
        AvatarPreparation<A> avatarPreparation,
        NotificationWriter<A> writer
    ) {
        return deliver(
            deliveryKey,
            notificationId,
            DEFAULT_AVATAR_DEADLINE_MILLIS,
            avatarPreparation,
            writer
        );
    }

    /**
     * Claims a full delivery key and returns the owner's shared result. A later
     * caller sees duplicate only after a confirmed post has completed.
     */
    public <A> CompletableFuture<DeliveryResult> deliver(
        String deliveryKey,
        int notificationId,
        long avatarDeadlineMillis,
        AvatarPreparation<A> avatarPreparation,
        NotificationWriter<A> writer
    ) {
        if (deliveryKey == null || deliveryKey.isEmpty()) {
            throw new IllegalArgumentException("deliveryKey must not be empty");
        }
        if (avatarDeadlineMillis < 0) {
            throw new IllegalArgumentException("avatarDeadlineMillis must not be negative");
        }
        Objects.requireNonNull(avatarPreparation, "avatarPreparation");
        Objects.requireNonNull(writer, "writer");

        InFlight claim;
        synchronized (ownershipLock) {
            DeliveryResult retained = completed.get(deliveryKey);
            if (retained != null) {
                return CompletableFuture.completedFuture(retained.asRetainedResult());
            }
            claim = inFlight.get(deliveryKey);
            if (claim != null) {
                return claim.result;
            }
            claim = new InFlight();
            inFlight.put(deliveryKey, claim);
        }

        startOwner(
            deliveryKey,
            notificationId,
            avatarDeadlineMillis,
            avatarPreparation,
            writer,
            claim
        );
        return claim.result;
    }

    /**
     * Returns the process-local owner result without claiming or posting. An
     * in-flight lookup shares the owner's future, while a completed lookup
     * reports the original terminal result rather than a duplicate attempt.
     */
    public CompletableFuture<DeliveryResult> status(String deliveryKey) {
        if (deliveryKey == null || deliveryKey.isEmpty()) {
            throw new IllegalArgumentException("deliveryKey must not be empty");
        }
        synchronized (ownershipLock) {
            DeliveryResult retained = completed.get(deliveryKey);
            if (retained != null) {
                return CompletableFuture.completedFuture(retained);
            }
            InFlight claim = inFlight.get(deliveryKey);
            if (claim != null) {
                return claim.result;
            }
        }
        return CompletableFuture.completedFuture(
            DeliveryResult.unavailable("No delivery is owned in this process")
        );
    }

    private <A> void startOwner(
        String deliveryKey,
        int notificationId,
        long avatarDeadlineMillis,
        AvatarPreparation<A> avatarPreparation,
        NotificationWriter<A> writer,
        InFlight claim
    ) {
        long startedAt = clock.nowMillis();
        long deadlineAt = deadline(startedAt, avatarDeadlineMillis);
        Selection<A> selection = new Selection<>(
            avatar -> write(deliveryKey, notificationId, avatar, writer, claim)
        );

        Cancellation cancellation;
        try {
            cancellation = clock.schedule(
                avatarDeadlineMillis,
                () -> selection.select(null)
            );
        } catch (RuntimeException exception) {
            selection.select(null);
            return;
        }
        if (cancellation == null) {
            selection.select(null);
            return;
        }
        selection.setDeadlineCancellation(cancellation);
        if (selection.isSelected()) {
            return;
        }

        CompletionStage<A> prepared;
        try {
            prepared = avatarPreparation.prepare();
        } catch (RuntimeException exception) {
            selection.select(null);
            return;
        }
        if (prepared == null) {
            selection.select(null);
            return;
        }
        prepared.whenComplete((avatar, exception) -> {
            if (exception != null || avatar == null || clock.nowMillis() >= deadlineAt) {
                selection.select(null);
                return;
            }
            selection.select(avatar);
        });
    }

    private <A> void write(
        String deliveryKey,
        int notificationId,
        A avatar,
        NotificationWriter<A> writer,
        InFlight claim
    ) {
        DeliveryResult result;
        try {
            result = writer.post(notificationId, avatar);
            if (result == null) {
                result = DeliveryResult.failed(
                    true,
                    "Notification writer returned no result"
                );
            }
        } catch (RuntimeException exception) {
            result = DeliveryResult.failed(true, safeError(exception));
        }
        finish(deliveryKey, claim, result);
    }

    private void finish(String deliveryKey, InFlight claim, DeliveryResult result) {
        synchronized (ownershipLock) {
            if (inFlight.get(deliveryKey) != claim) {
                return;
            }
            inFlight.remove(deliveryKey);
            completed.put(deliveryKey, result);
            while (completed.size() > completedCapacity) {
                String eldest = completed.keySet().iterator().next();
                completed.remove(eldest);
            }
        }
        claim.result.complete(result);
    }

    private static long deadline(long startedAt, long durationMillis) {
        long deadlineAt = startedAt + durationMillis;
        if (durationMillis > 0 && deadlineAt < startedAt) {
            return Long.MAX_VALUE;
        }
        return deadlineAt;
    }

    private static String safeError(RuntimeException exception) {
        return exception.getClass().getSimpleName();
    }

    int completedCount() {
        synchronized (ownershipLock) {
            return completed.size();
        }
    }

    int inFlightCount() {
        synchronized (ownershipLock) {
            return inFlight.size();
        }
    }

    private static final class Selection<A> {
        private final AtomicBoolean selected = new AtomicBoolean();
        private final AtomicReference<Cancellation> deadlineCancellation =
            new AtomicReference<>();
        private final SelectionWriter<A> writer;

        Selection(SelectionWriter<A> writer) {
            this.writer = writer;
        }

        void setDeadlineCancellation(Cancellation cancellation) {
            deadlineCancellation.set(cancellation);
            if (selected.get()) {
                cancellation.cancel();
            }
        }

        boolean isSelected() {
            return selected.get();
        }

        void select(A avatar) {
            if (!selected.compareAndSet(false, true)) {
                return;
            }
            Cancellation cancellation = deadlineCancellation.get();
            if (cancellation != null) {
                cancellation.cancel();
            }
            writer.write(avatar);
        }
    }

    @FunctionalInterface
    private interface SelectionWriter<A> {
        void write(A avatar);
    }

    private static final class SystemClock implements Clock {
        private final ScheduledExecutorService scheduler =
            Executors.newSingleThreadScheduledExecutor(runnable -> {
                Thread thread = new Thread(runnable, "notification-delivery-deadline");
                thread.setDaemon(true);
                return thread;
            });

        @Override
        public long nowMillis() {
            return TimeUnit.NANOSECONDS.toMillis(System.nanoTime());
        }

        @Override
        public Cancellation schedule(long delayMillis, Runnable task) {
            ScheduledFuture<?> future = scheduler.schedule(
                task,
                delayMillis,
                TimeUnit.MILLISECONDS
            );
            return () -> future.cancel(false);
        }
    }
}
