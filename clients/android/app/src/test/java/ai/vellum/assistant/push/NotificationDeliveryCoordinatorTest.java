package ai.vellum.assistant.push;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import ai.vellum.assistant.push.NotificationDeliveryCoordinator.DeliveryResult;
import ai.vellum.assistant.push.NotificationDeliveryCoordinator.DeliveryStatus;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;

public class NotificationDeliveryCoordinatorTest {
    private static final int NOTIFICATION_ID = 42;
    private static final long DEADLINE_MILLIS = 1_000;

    @Test
    public void fcmFirstPostsAndALaterLocalCallIsDuplicate() {
        TestClock clock = new TestClock();
        NotificationDeliveryCoordinator coordinator = coordinator(clock, 8);
        AtomicInteger writes = new AtomicInteger();

        DeliveryResult fcm = coordinator
            .deliver("delivery-1", NOTIFICATION_ID, DEADLINE_MILLIS, noAvatar(), posted(writes))
            .join();
        DeliveryResult local = coordinator
            .deliver("delivery-1", NOTIFICATION_ID, DEADLINE_MILLIS, noAvatar(), posted(writes))
            .join();

        assertEquals(DeliveryStatus.POSTED, fcm.status);
        assertEquals(DeliveryStatus.DUPLICATE, local.status);
        assertEquals(1, writes.get());
    }

    @Test
    public void localFirstPostsAndALaterFcmCallIsDuplicate() {
        TestClock clock = new TestClock();
        NotificationDeliveryCoordinator coordinator = coordinator(clock, 8);
        AtomicInteger writes = new AtomicInteger();

        DeliveryResult local = coordinator
            .deliver("delivery-1", NOTIFICATION_ID, DEADLINE_MILLIS, noAvatar(), posted(writes))
            .join();
        DeliveryResult fcm = coordinator
            .deliver("delivery-1", NOTIFICATION_ID, DEADLINE_MILLIS, noAvatar(), posted(writes))
            .join();

        assertEquals(DeliveryStatus.POSTED, local.status);
        assertEquals(DeliveryStatus.DUPLICATE, fcm.status);
        assertEquals(1, writes.get());
    }

    @Test
    public void simultaneousCallersShareTheOwnersInFlightResult() throws Exception {
        TestClock clock = new TestClock();
        NotificationDeliveryCoordinator coordinator = coordinator(clock, 8);
        CompletableFuture<String> avatar = new CompletableFuture<>();
        AtomicInteger preparations = new AtomicInteger();
        AtomicInteger writes = new AtomicInteger();
        CountDownLatch start = new CountDownLatch(1);
        ExecutorService callers = Executors.newFixedThreadPool(2);
        try {
            Future<CompletableFuture<DeliveryResult>> firstCall = callers.submit(() -> {
                start.await();
                return coordinator.deliver(
                    "delivery-1",
                    NOTIFICATION_ID,
                    DEADLINE_MILLIS,
                    () -> {
                        preparations.incrementAndGet();
                        return avatar;
                    },
                    posted(writes)
                );
            });
            Future<CompletableFuture<DeliveryResult>> secondCall = callers.submit(() -> {
                start.await();
                return coordinator.deliver(
                    "delivery-1",
                    NOTIFICATION_ID,
                    DEADLINE_MILLIS,
                    () -> {
                        preparations.incrementAndGet();
                        return avatar;
                    },
                    posted(writes)
                );
            });

            start.countDown();
            CompletableFuture<DeliveryResult> first = firstCall.get(1, TimeUnit.SECONDS);
            CompletableFuture<DeliveryResult> second = secondCall.get(1, TimeUnit.SECONDS);

            assertSame(first, second);
            assertEquals(1, preparations.get());
            assertFalse(first.isDone());

            avatar.complete("avatar");

            assertEquals(DeliveryStatus.POSTED, first.join().status);
            assertEquals(DeliveryStatus.POSTED, second.join().status);
            assertEquals(1, writes.get());
        } finally {
            callers.shutdownNow();
        }
    }

    @Test
    public void distinctFullKeysPostDespiteIntegerNotificationIdCollision() {
        assertEquals("FB".hashCode(), "Ea".hashCode());
        int collision = Math.abs("FB".hashCode());
        TestClock clock = new TestClock();
        NotificationDeliveryCoordinator coordinator = coordinator(clock, 8);
        AtomicInteger writes = new AtomicInteger();

        DeliveryResult first = coordinator
            .deliver("FB", collision, DEADLINE_MILLIS, noAvatar(), posted(writes, collision))
            .join();
        DeliveryResult second = coordinator
            .deliver("Ea", collision, DEADLINE_MILLIS, noAvatar(), posted(writes, collision))
            .join();

        assertEquals(DeliveryStatus.POSTED, first.status);
        assertEquals(DeliveryStatus.POSTED, second.status);
        assertEquals(2, writes.get());
    }

    @Test
    public void duplicateRemainsSuppressedAfterTheNotificationIsDismissed() {
        TestClock clock = new TestClock();
        NotificationDeliveryCoordinator coordinator = coordinator(clock, 8);
        AtomicInteger writes = new AtomicInteger();

        assertEquals(
            DeliveryStatus.POSTED,
            coordinator
                .deliver(
                    "delivery-1",
                    NOTIFICATION_ID,
                    DEADLINE_MILLIS,
                    noAvatar(),
                    posted(writes)
                )
                .join()
                .status
        );
        // Dismissal changes OS state only. The retained process-local result remains authoritative.
        assertEquals(
            DeliveryStatus.DUPLICATE,
            coordinator
                .deliver(
                    "delivery-1",
                    NOTIFICATION_ID,
                    DEADLINE_MILLIS,
                    noAvatar(),
                    posted(writes)
                )
                .join()
                .status
        );
        assertEquals(1, writes.get());
    }

    @Test
    public void evictsTheLeastRecentlyUsedCompletedEntryAtTheBound() {
        TestClock clock = new TestClock();
        NotificationDeliveryCoordinator coordinator = coordinator(clock, 2);
        AtomicInteger writes = new AtomicInteger();

        deliverPosted(coordinator, "delivery-1", writes);
        deliverPosted(coordinator, "delivery-2", writes);
        assertEquals(
            DeliveryStatus.DUPLICATE,
            coordinator
                .deliver(
                    "delivery-1",
                    NOTIFICATION_ID,
                    DEADLINE_MILLIS,
                    noAvatar(),
                    posted(writes)
                )
                .join()
                .status
        );
        deliverPosted(coordinator, "delivery-3", writes);

        assertEquals(2, coordinator.completedCount());
        assertEquals(
            "the untouched entry was evicted",
            DeliveryStatus.POSTED,
            coordinator
                .deliver(
                    "delivery-2",
                    NOTIFICATION_ID,
                    DEADLINE_MILLIS,
                    noAvatar(),
                    posted(writes)
                )
                .join()
                .status
        );
        assertEquals(4, writes.get());
    }

    @Test
    public void completedEvictionNeverDiscardsActiveOwners() {
        TestClock clock = new TestClock();
        NotificationDeliveryCoordinator coordinator = coordinator(clock, 1);
        CompletableFuture<String> firstAvatar = new CompletableFuture<>();
        CompletableFuture<String> secondAvatar = new CompletableFuture<>();
        AtomicInteger writes = new AtomicInteger();

        CompletableFuture<DeliveryResult> first = coordinator.deliver(
            "delivery-1",
            NOTIFICATION_ID,
            DEADLINE_MILLIS,
            () -> firstAvatar,
            posted(writes)
        );
        CompletableFuture<DeliveryResult> second = coordinator.deliver(
            "delivery-2",
            NOTIFICATION_ID,
            DEADLINE_MILLIS,
            () -> secondAvatar,
            posted(writes)
        );

        assertEquals(2, coordinator.inFlightCount());
        firstAvatar.complete("first");
        secondAvatar.complete("second");

        assertEquals(DeliveryStatus.POSTED, first.join().status);
        assertEquals(DeliveryStatus.POSTED, second.join().status);
        assertEquals(2, writes.get());
        assertEquals(0, coordinator.inFlightCount());
        assertEquals(1, coordinator.completedCount());
    }

    @Test
    public void slowAvatarSelectsPlainOnceAndLatePreparationCannotPost() {
        TestClock clock = new TestClock();
        NotificationDeliveryCoordinator coordinator = coordinator(clock, 8);
        CompletableFuture<String> avatar = new CompletableFuture<>();
        AtomicInteger writes = new AtomicInteger();
        AtomicReference<String> writtenAvatar = new AtomicReference<>();

        CompletableFuture<DeliveryResult> result = coordinator.deliver(
            "delivery-1",
            NOTIFICATION_ID,
            DEADLINE_MILLIS,
            () -> avatar,
            (notificationId, selectedAvatar) -> {
                writes.incrementAndGet();
                writtenAvatar.set(selectedAvatar);
                return DeliveryResult.posted();
            }
        );

        clock.advanceBy(DEADLINE_MILLIS);
        assertEquals(DeliveryStatus.POSTED, result.join().status);
        assertNull(writtenAvatar.get());

        avatar.complete("late-avatar");
        assertEquals(1, writes.get());
        assertNull(writtenAvatar.get());
    }

    @Test
    public void preparedAvatarWinsBeforeTheDeadline() {
        TestClock clock = new TestClock();
        NotificationDeliveryCoordinator coordinator = coordinator(clock, 8);
        AtomicInteger writes = new AtomicInteger();
        AtomicReference<String> writtenAvatar = new AtomicReference<>();

        DeliveryResult result = coordinator
            .deliver(
                "delivery-1",
                NOTIFICATION_ID,
                DEADLINE_MILLIS,
                () -> CompletableFuture.completedFuture("avatar"),
                (notificationId, avatar) -> {
                    writes.incrementAndGet();
                    writtenAvatar.set(avatar);
                    return DeliveryResult.posted();
                }
            )
            .join();

        clock.advanceBy(DEADLINE_MILLIS);
        assertEquals(DeliveryStatus.POSTED, result.status);
        assertEquals("avatar", writtenAvatar.get());
        assertEquals(1, writes.get());
    }

    @Test
    public void preparationFailureFallsBackToOnePlainWriterCall() {
        TestClock clock = new TestClock();
        NotificationDeliveryCoordinator coordinator = coordinator(clock, 8);
        AtomicInteger writes = new AtomicInteger();
        AtomicReference<String> writtenAvatar = new AtomicReference<>();

        DeliveryResult result = coordinator
            .deliver(
                "delivery-1",
                NOTIFICATION_ID,
                DEADLINE_MILLIS,
                () -> {
                    CompletableFuture<String> failed = new CompletableFuture<>();
                    failed.completeExceptionally(new IllegalStateException("invalid avatar"));
                    return failed;
                },
                (notificationId, selectedAvatar) -> {
                    writes.incrementAndGet();
                    writtenAvatar.set(selectedAvatar);
                    return DeliveryResult.posted();
                }
            )
            .join();

        assertEquals(DeliveryStatus.POSTED, result.status);
        assertEquals(1, writes.get());
        assertNull(writtenAvatar.get());
    }

    @Test
    public void returnsBlockedWithoutInventingSuccess() {
        DeliveryResult blocked = terminalResult(
            DeliveryResult.blocked("Notifications are disabled")
        );

        assertEquals(DeliveryStatus.BLOCKED, blocked.status);
        assertFalse(blocked.postingMayHaveBegun);
        assertEquals("Notifications are disabled", blocked.reason);
        assertNull(blocked.error);
    }

    @Test
    public void returnsConfirmedWriterFailureWithSubmissionState() {
        DeliveryResult failed = terminalResult(
            DeliveryResult.failed(true, "Notification manager rejected the post")
        );

        assertEquals(DeliveryStatus.FAILED, failed.status);
        assertTrue(failed.postingMayHaveBegun);
        assertEquals("Notification manager rejected the post", failed.error);
        assertNull(failed.reason);
    }

    @Test
    public void writerExceptionBecomesARetainedConfirmedFailure() {
        TestClock clock = new TestClock();
        NotificationDeliveryCoordinator coordinator = coordinator(clock, 8);
        AtomicInteger writes = new AtomicInteger();
        NotificationDeliveryCoordinator.NotificationWriter<Object> writer =
            (notificationId, avatar) -> {
                writes.incrementAndGet();
                throw new IllegalStateException("payload content is not returned");
            };

        DeliveryResult first = coordinator
            .deliver("delivery-1", NOTIFICATION_ID, DEADLINE_MILLIS, noAvatar(), writer)
            .join();
        DeliveryResult second = coordinator
            .deliver("delivery-1", NOTIFICATION_ID, DEADLINE_MILLIS, noAvatar(), writer)
            .join();

        assertEquals(DeliveryStatus.FAILED, first.status);
        assertTrue(first.postingMayHaveBegun);
        assertEquals("IllegalStateException", first.error);
        assertSame(first, second);
        assertEquals(1, writes.get());
    }

    @Test
    public void unknownIsATombstoneAndNeverRepostsWhileRetained() {
        TestClock clock = new TestClock();
        NotificationDeliveryCoordinator coordinator = coordinator(clock, 8);
        AtomicInteger writes = new AtomicInteger();
        NotificationDeliveryCoordinator.NotificationWriter<Object> writer =
            (notificationId, avatar) -> {
                writes.incrementAndGet();
                return DeliveryResult.unknown("Delivery response was not confirmed");
            };

        DeliveryResult first = coordinator
            .deliver("delivery-1", NOTIFICATION_ID, DEADLINE_MILLIS, noAvatar(), writer)
            .join();
        DeliveryResult second = coordinator
            .deliver("delivery-1", NOTIFICATION_ID, DEADLINE_MILLIS, noAvatar(), writer)
            .join();

        assertEquals(DeliveryStatus.UNKNOWN, first.status);
        assertEquals(DeliveryStatus.UNKNOWN, second.status);
        assertTrue(first.postingMayHaveBegun);
        assertEquals("Delivery response was not confirmed", first.reason);
        assertEquals(1, writes.get());
    }

    @Test
    public void returnsUnavailableOnlyBeforePostingCouldBegin() {
        DeliveryResult unavailable = terminalResult(
            DeliveryResult.unavailable("Native delivery is unavailable")
        );

        assertEquals(DeliveryStatus.UNAVAILABLE, unavailable.status);
        assertFalse(unavailable.postingMayHaveBegun);
        assertEquals("Native delivery is unavailable", unavailable.reason);
    }

    @Test
    public void aFreshCoordinatorStartsWithoutDurableReceipts() {
        TestClock clock = new TestClock();
        AtomicInteger writes = new AtomicInteger();
        NotificationDeliveryCoordinator firstProcess = coordinator(clock, 8);
        NotificationDeliveryCoordinator restartedProcess = coordinator(clock, 8);

        deliverPosted(firstProcess, "delivery-1", writes);
        DeliveryResult afterRestart = restartedProcess
            .deliver("delivery-1", NOTIFICATION_ID, DEADLINE_MILLIS, noAvatar(), posted(writes))
            .join();

        assertEquals(DeliveryStatus.POSTED, afterRestart.status);
        assertEquals(2, writes.get());
    }

    @Test
    public void bridgeReloadUsesTheSameProcessSharedOwner() {
        NotificationDeliveryCoordinator beforeReload = NotificationDeliveryCoordinator.shared();
        NotificationDeliveryCoordinator afterReload = NotificationDeliveryCoordinator.shared();
        AtomicInteger writes = new AtomicInteger();

        DeliveryResult first = beforeReload
            .deliver(
                "delivery-bridge-reload-test",
                NOTIFICATION_ID,
                noAvatar(),
                posted(writes)
            )
            .join();
        DeliveryResult second = afterReload
            .deliver(
                "delivery-bridge-reload-test",
                NOTIFICATION_ID,
                noAvatar(),
                posted(writes)
            )
            .join();

        assertSame(beforeReload, afterReload);
        assertEquals(DeliveryStatus.POSTED, first.status);
        assertEquals(DeliveryStatus.DUPLICATE, second.status);
        assertEquals(1, writes.get());
    }

    @Test
    public void statusSharesInFlightAndReportsTheOriginalCompletedResult() {
        TestClock clock = new TestClock();
        NotificationDeliveryCoordinator coordinator = coordinator(clock, 8);
        CompletableFuture<String> avatar = new CompletableFuture<>();
        AtomicInteger writes = new AtomicInteger();

        CompletableFuture<DeliveryResult> delivery = coordinator.deliver(
            "delivery-1",
            NOTIFICATION_ID,
            DEADLINE_MILLIS,
            () -> avatar,
            posted(writes)
        );

        assertSame(delivery, coordinator.status("delivery-1"));
        avatar.complete("avatar");
        assertEquals(DeliveryStatus.POSTED, coordinator.status("delivery-1").join().status);
        assertEquals(
            DeliveryStatus.UNAVAILABLE,
            coordinator.status("delivery-not-owned").join().status
        );
        assertEquals(1, writes.get());
    }

    private static NotificationDeliveryCoordinator coordinator(TestClock clock, int capacity) {
        return new NotificationDeliveryCoordinator(clock, capacity);
    }

    private static NotificationDeliveryCoordinator.AvatarPreparation<Object> noAvatar() {
        return () -> CompletableFuture.completedFuture(null);
    }

    private static <A> NotificationDeliveryCoordinator.NotificationWriter<A> posted(
        AtomicInteger writes
    ) {
        return posted(writes, NOTIFICATION_ID);
    }

    private static <A> NotificationDeliveryCoordinator.NotificationWriter<A> posted(
        AtomicInteger writes,
        int expectedNotificationId
    ) {
        return (notificationId, avatar) -> {
            assertEquals(expectedNotificationId, notificationId);
            writes.incrementAndGet();
            return DeliveryResult.posted();
        };
    }

    private static void deliverPosted(
        NotificationDeliveryCoordinator coordinator,
        String deliveryKey,
        AtomicInteger writes
    ) {
        assertEquals(
            DeliveryStatus.POSTED,
            coordinator
                .deliver(
                    deliveryKey,
                    NOTIFICATION_ID,
                    DEADLINE_MILLIS,
                    noAvatar(),
                    posted(writes)
                )
                .join()
                .status
        );
    }

    private static DeliveryResult terminalResult(DeliveryResult writerResult) {
        TestClock clock = new TestClock();
        NotificationDeliveryCoordinator coordinator = coordinator(clock, 8);
        return coordinator
            .deliver(
                "delivery-1",
                NOTIFICATION_ID,
                DEADLINE_MILLIS,
                noAvatar(),
                (notificationId, avatar) -> writerResult
            )
            .join();
    }

    private static final class TestClock implements NotificationDeliveryCoordinator.Clock {
        private final List<ScheduledTask> tasks = new ArrayList<>();
        private long nowMillis;

        @Override
        public synchronized long nowMillis() {
            return nowMillis;
        }

        @Override
        public synchronized NotificationDeliveryCoordinator.Cancellation schedule(
            long delayMillis,
            Runnable task
        ) {
            ScheduledTask scheduled = new ScheduledTask(nowMillis + delayMillis, task);
            tasks.add(scheduled);
            return () -> {
                synchronized (TestClock.this) {
                    scheduled.cancelled = true;
                }
            };
        }

        void advanceBy(long millis) {
            List<ScheduledTask> due = new ArrayList<>();
            synchronized (this) {
                nowMillis += millis;
                tasks.sort(Comparator.comparingLong(task -> task.deadlineMillis));
                for (ScheduledTask task : tasks) {
                    if (!task.cancelled && task.deadlineMillis <= nowMillis) {
                        task.cancelled = true;
                        due.add(task);
                    }
                }
            }
            for (ScheduledTask task : due) {
                task.operation.run();
            }
        }
    }

    private static final class ScheduledTask {
        final long deadlineMillis;
        final Runnable operation;
        boolean cancelled;

        ScheduledTask(long deadlineMillis, Runnable operation) {
            this.deadlineMillis = deadlineMillis;
            this.operation = operation;
        }
    }
}
