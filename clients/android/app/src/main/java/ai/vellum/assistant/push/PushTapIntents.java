package ai.vellum.assistant.push;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import androidx.annotation.Nullable;
import com.google.firebase.messaging.RemoteMessage;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Tap targets for natively rendered pushes. The launch intent carries the data
 * payload plus {@code google.message_id}, which is what
 * {@code PushNotificationsPlugin.handleOnNewIntent} keys on to emit
 * {@code pushNotificationActionPerformed} for the web deep-link handler.
 */
public final class PushTapIntents {
    static final String MESSAGE_ID_EXTRA = "google.message_id";

    private PushTapIntents() {}

    @Nullable
    public static Intent launchIntent(Context context, RemoteMessage remoteMessage) {
        Intent intent = launcherIntent(context);
        if (intent == null) {
            return null;
        }
        for (Map.Entry<String, String> extra : tapExtras(
            remoteMessage.getData(),
            remoteMessage.getMessageId()
        ).entrySet()) {
            intent.putExtra(extra.getKey(), extra.getValue());
        }
        return intent;
    }

    /**
     * Tap target for a conversation shortcut, which outlives the push that
     * created it. It names the conversation and nothing else: carrying the
     * push's identifiers would make a shortcut tap replay a delivery the user
     * has already read.
     */
    @Nullable
    public static Intent shortcutIntent(Context context, @Nullable String conversationId) {
        Intent intent = launcherIntent(context);
        if (intent == null) {
            return null;
        }
        if (conversationId != null) {
            intent.putExtra(PushDataMessage.KEY_CONVERSATION_ID, conversationId);
        }
        return intent;
    }

    public static PendingIntent pendingIntent(Context context, Intent intent, int requestCode) {
        return PendingIntent.getActivity(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );
    }

    @Nullable
    private static Intent launcherIntent(Context context) {
        Intent intent = context
            .getPackageManager()
            .getLaunchIntentForPackage(context.getPackageName());
        if (intent == null) {
            return null;
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return intent;
    }

    static Map<String, String> tapExtras(
        @Nullable Map<String, String> data,
        @Nullable String messageId
    ) {
        Map<String, String> extras = new LinkedHashMap<>();
        if (data != null) {
            extras.putAll(data);
        }
        String id = PushDataMessage.trimmed(messageId);
        if (id == null) {
            id = PushDataMessage.trimmed(extras.get(PushDataMessage.KEY_DELIVERY_ID));
        }
        if (id != null) {
            extras.put(MESSAGE_ID_EXTRA, id);
        }
        return extras;
    }
}
