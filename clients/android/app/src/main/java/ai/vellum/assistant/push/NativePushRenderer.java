package ai.vellum.assistant.push;

import ai.vellum.assistant.AndroidNotificationChannelsPlugin;
import ai.vellum.assistant.NativeFailureGuard;
import ai.vellum.assistant.R;
import android.Manifest;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.os.Build;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.Person;
import androidx.core.content.ContextCompat;
import androidx.core.content.pm.ShortcutInfoCompat;
import androidx.core.content.pm.ShortcutManagerCompat;
import androidx.core.graphics.drawable.IconCompat;
import com.google.firebase.messaging.RemoteMessage;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * Renders a data-only push. With a sender the notification is a
 * {@code MessagingStyle} conversation: the avatar is the large icon, the
 * assistant's name is the message line, and the conversation title is the
 * header. The avatar is the only optional part of that treatment. Without a
 * sender the notification matches what Firebase rendered from a notification
 * block.
 */
public final class NativePushRenderer {
    /**
     * The launcher gives one app a small shortcut budget shared with the static
     * New chat and Start voice entries, so only the two most recent
     * conversations keep a shortcut.
     */
    private static final int MAX_CONVERSATION_SHORTCUTS = 2;

    private NativePushRenderer() {}

    public static void show(
        Context context,
        RemoteMessage remoteMessage,
        PushDataMessage message,
        @Nullable Bitmap avatar
    ) {
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED
        ) {
            return;
        }
        NotificationManagerCompat manager = NotificationManagerCompat.from(context);
        if (!manager.areNotificationsEnabled()) {
            return;
        }

        int notificationId = message.notificationId();
        Intent launchIntent = PushTapIntents.launchIntent(context, remoteMessage);
        PendingIntent contentIntent = launchIntent == null
            ? null
            : PushTapIntents.pendingIntent(context, launchIntent, notificationId);
        String body = message.body == null ? "" : message.body;

        NotificationCompat.Builder builder = new NotificationCompat.Builder(
            context,
            AndroidNotificationChannelsPlugin.resolveChannelId(context, message.channelId)
        )
            .setSmallIcon(R.drawable.ic_stat_notification)
            .setColor(ContextCompat.getColor(context, R.color.notification_icon_color))
            .setContentIntent(contentIntent)
            .setAutoCancel(true);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            // From API 26 the channel owns the sound. Before it, a notification
            // that asks for nothing arrives silently.
            builder.setDefaults(NotificationCompat.DEFAULT_SOUND);
        }
        if (message.unreadCount != null && message.unreadCount > 0) {
            builder.setNumber(message.unreadCount);
        }

        PushDataMessage.Sender sender = message.sender;
        if (sender == null) {
            builder
                .setContentTitle(message.title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body));
            manager.notify(notificationId, builder.build());
            return;
        }

        // The avatar can be absent: the platform omits the signed url on an
        // oversized payload, and a download that times out inside the Firebase
        // callback window gives up. The conversation treatment does not depend
        // on it.
        IconCompat icon = avatar == null ? null : IconCompat.createWithBitmap(avatar);
        Person.Builder personBuilder = new Person.Builder().setKey(sender.id).setName(sender.name);
        if (icon != null) {
            personBuilder.setIcon(icon);
        }
        Person person = personBuilder.build();
        builder
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setOnlyAlertOnce(true)
            .setStyle(
                new NotificationCompat.MessagingStyle(
                    new Person.Builder()
                        .setName(context.getString(R.string.notification_self_name))
                        .build()
                )
                    .setGroupConversation(true)
                    .setConversationTitle(message.title)
                    .addMessage(body, System.currentTimeMillis(), person)
            );
        String shortcutId = pushShortcut(context, message, sender, person, icon);
        if (shortcutId != null) {
            builder.setShortcutId(shortcutId);
        }

        manager.notify(notificationId, builder.build());
    }

    /** The shortcut id once it is live, which is what lets the notification claim it. */
    @Nullable
    private static String pushShortcut(
        Context context,
        PushDataMessage message,
        PushDataMessage.Sender sender,
        Person person,
        @Nullable IconCompat icon
    ) {
        Intent intent = PushTapIntents.shortcutIntent(context, message.conversationId);
        if (intent == null) {
            return null;
        }
        String shortcutId = PushDataMessage.shortcutId(sender.id, message.conversationId);
        boolean pushed = NativeFailureGuard.get(
            "Unable to publish the Android conversation shortcut",
            () -> {
                trimConversationShortcuts(context, shortcutId);
                ShortcutInfoCompat.Builder shortcut =
                    new ShortcutInfoCompat.Builder(context, shortcutId)
                        .setLongLived(true)
                        .setPerson(person)
                        .setShortLabel(PushDataMessage.shortcutLabel(message.title, sender.name))
                        .setIntent(intent);
                if (icon != null) {
                    shortcut.setIcon(icon);
                }
                return ShortcutManagerCompat.pushDynamicShortcut(context, shortcut.build());
            },
            false
        );
        return pushed ? shortcutId : null;
    }

    /** Drops our oldest conversation shortcuts so the new one fits within the cap. */
    private static void trimConversationShortcuts(Context context, String keptId) {
        List<ShortcutInfoCompat> ours = new ArrayList<>();
        for (ShortcutInfoCompat shortcut : ShortcutManagerCompat.getDynamicShortcuts(context)) {
            String id = shortcut.getId();
            if (id.startsWith(PushDataMessage.SHORTCUT_ID_PREFIX) && !id.equals(keptId)) {
                ours.add(shortcut);
            }
        }
        int surplus = ours.size() - (MAX_CONVERSATION_SHORTCUTS - 1);
        if (surplus <= 0) {
            return;
        }
        ours.sort(Comparator.comparingLong(ShortcutInfoCompat::getLastChangedTimestamp));
        List<String> stale = new ArrayList<>();
        for (ShortcutInfoCompat oldest : ours.subList(0, surplus)) {
            stale.add(oldest.getId());
        }
        ShortcutManagerCompat.removeLongLivedShortcuts(context, stale);
    }
}
