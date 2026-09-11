package ai.vellum.assistant;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import ai.vellum.assistant.push.NotificationDeliveryCoordinator;
import ai.vellum.assistant.push.PushDataMessage;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.Test;

public class SafeMessagingServiceTest {
    @Test
    public void negotiatedForegroundPushesStillReachTheWebFocusPolicy() {
        assertEquals(
            SafeMessagingService.DeliveryRoute.CAPACITOR_PLUGIN,
            SafeMessagingService.deliveryRoute(true, true)
        );
        assertEquals(
            SafeMessagingService.DeliveryRoute.NATIVE_COORDINATOR,
            SafeMessagingService.deliveryRoute(true, false)
        );
    }

    @Test
    public void legacyRoutingKeepsForegroundWebAndBackgroundNative() {
        assertEquals(
            SafeMessagingService.DeliveryRoute.CAPACITOR_PLUGIN,
            SafeMessagingService.deliveryRoute(true, true)
        );
        assertEquals(
            SafeMessagingService.DeliveryRoute.NATIVE_COORDINATOR,
            SafeMessagingService.deliveryRoute(true, false)
        );
    }

    @Test
    public void notificationBlocksAlwaysStayWithTheCapacitorPlugin() {
        assertEquals(
            SafeMessagingService.DeliveryRoute.CAPACITOR_PLUGIN,
            SafeMessagingService.deliveryRoute(false, false)
        );
    }

    @Test
    public void negotiatedOwnershipNeverFallsBackAfterClaiming() {
        assertTrue(
            SafeMessagingService.nativeOwnsResult(
                NotificationDeliveryCoordinator.DeliveryResult.blocked(
                    "authorization_denied"
                ),
                true
            )
        );
        assertTrue(
            SafeMessagingService.nativeOwnsResult(
                NotificationDeliveryCoordinator.DeliveryResult.unknown(
                    false,
                    "writer_unavailable",
                    null
                ),
                true
            )
        );
    }

    @Test
    public void legacyRouteFallsBackOnlyWhenPostingCouldNotHaveBegun() {
        assertFalse(
            SafeMessagingService.nativeOwnsResult(
                NotificationDeliveryCoordinator.DeliveryResult.failed(
                    false,
                    "writer_unavailable"
                ),
                false
            )
        );
        assertTrue(
            SafeMessagingService.nativeOwnsResult(
                NotificationDeliveryCoordinator.DeliveryResult.unknown(
                    true,
                    "post_unconfirmed",
                    null
                ),
                false
            )
        );
    }

    @Test
    public void throwableFallbackChangesOwnershipAtTheCoordinatorClaimBoundary() {
        NotificationDeliveryCoordinator.DeliveryResult preClaim =
            SafeMessagingService.deliveryFailure(false, new AssertionError());
        NotificationDeliveryCoordinator.DeliveryResult postClaim =
            SafeMessagingService.deliveryFailure(true, new AssertionError());

        assertFalse(SafeMessagingService.nativeOwnsResult(preClaim, false));
        assertTrue(SafeMessagingService.nativeOwnsResult(postClaim, false));
        assertTrue(
            SafeMessagingService.nativeOwnsResult(
                SafeMessagingService.claimedResult(preClaim),
                false
            )
        );
    }

    @Test
    public void fcmAndLocalUseTheSameExactTrimmedCoordinatorKey() {
        String fcm = SafeMessagingService.deliveryKey(
            " correlation-1 ",
            "message-1",
            data()
        );
        String local = PushDataMessage.deliveryKey(
            " correlation-1 ",
            "delivery-1",
            "request-1"
        );

        assertEquals("correlation-1", fcm);
        assertEquals(local, fcm);
    }

    @Test
    public void fcmAndLocalShareUnicodeWhitespaceAndLengthBounds() {
        String padded = "\u00A0\uFEFFdelivery-1\u3000";
        assertEquals(
            PushDataMessage.deliveryKey(padded, null, null),
            SafeMessagingService.deliveryKey(padded, null, data())
        );
        assertEquals("delivery-1", SafeMessagingService.deliveryKey(padded, null, data()));
        String tooLong = "x".repeat(513);
        assertNull(PushDataMessage.deliveryKey(tooLong, null, null));
        Map<String, String> oversizedData = new LinkedHashMap<>();
        oversizedData.put("title", tooLong);
        assertNull(SafeMessagingService.deliveryKey(tooLong, null, oversizedData));
        assertNull(
            SafeMessagingService.deliveryKey(tooLong, "message-1", data())
        );
    }

    @Test
    public void missingDeliveryIdUsesAFullNonNumericFallbackKey() {
        assertEquals(
            "fcm-message:message-1",
            SafeMessagingService.deliveryKey(null, " message-1 ", data())
        );
    }

    @Test
    public void blockedDeliveryDoesNotStartAvatarPreparation() {
        AtomicBoolean prepared = new AtomicBoolean();

        Object avatar = SafeMessagingService.prepareAvatar(
            "authorization_denied",
            () -> {
                prepared.set(true);
                return new Object();
            }
        ).join();

        assertFalse(prepared.get());
        assertNull(avatar);
    }

    private static Map<String, String> data() {
        Map<String, String> data = new LinkedHashMap<>();
        data.put("title", "Weekly review");
        data.put("body", "Ready when you are.");
        return data;
    }
}
