package ai.vellum.assistant.push;

import ai.vellum.assistant.AndroidNotificationChannelsPlugin;
import ai.vellum.assistant.NativeFailureGuard;
import ai.vellum.assistant.R;
import ai.vellum.assistant.SelfHostedServer;
import android.Manifest;
import android.annotation.SuppressLint;
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
import java.net.URI;
import java.util.ArrayList;
import java.util.Collections;
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
     * How many conversations keep a launcher shortcut. Two is a product choice
     * about how much of the launcher's shortcut list a notification may claim.
     * The launcher's own budget counts the static New chat and Start voice
     * entries towards the same total, but they are manifest shortcuts, so a
     * dynamic push can only ever evict another dynamic one.
     */
    private static final int MAX_CONVERSATION_SHORTCUTS = 2;

    private NativePushRenderer() {}

    /**
     * Whether a notification would reach the user at all. Checked before the
     * avatar is resolved so a device that denied notifications pays for no
     * download.
     */
    public static boolean canPost(Context context) {
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED
        ) {
            return false;
        }
        return NotificationManagerCompat.from(context).areNotificationsEnabled();
    }

    /**
     * Posts the notification. The caller checks {@link #canPost} first, which
     * is the POST_NOTIFICATIONS check lint cannot follow across a method
     * boundary.
     */
    @SuppressLint("MissingPermission")
    public static void show(
        Context context,
        RemoteMessage remoteMessage,
        PushDataMessage message,
        @Nullable Bitmap avatar
    ) {
        AndroidNotificationChannelsPlugin.ensureAlertsChannel(context, message.channelId);
        NotificationManagerCompat manager = NotificationManagerCompat.from(context);

        int notificationId = message.notificationId();
        Intent launchIntent = PushTapIntents.launchIntent(context, remoteMessage);
        PendingIntent contentIntent = launchIntent == null
            ? null
            : PushTapIntents.pendingIntent(context, launchIntent, notificationId);
        String body = message.body == null ? "" : message.body;

        NotificationCompat.Builder builder = new NotificationCompat.Builder(
            context,
            AndroidNotificationChannelsPlugin.ALERTS_CHANNEL_ID
        )
            .setSmallIcon(R.drawable.ic_stat_notification)
            .setColor(ContextCompat.getColor(context, R.color.notification_icon_color))
            .setContentIntent(contentIntent)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true);
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

    /** Forgets every conversation shortcut this renderer owns. */
    public static void clearConversationShortcuts(Context context) {
        List<String> ours = ownedShortcutIds(dynamicShortcutIds(context), null);
        if (!ours.isEmpty()) {
            ShortcutManagerCompat.removeLongLivedShortcuts(context, ours);
        }
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
        String conversationId = message.conversationId;
        if (
            !publishesConversationShortcut(conversationId, SelfHostedServer.configured(context))
        ) {
            return null;
        }
        Intent intent = PushTapIntents.shortcutIntent(context, conversationId);
        if (intent == null) {
            return null;
        }
        String shortcutId = PushDataMessage.shortcutId(sender.id, conversationId);
        // Trimming is housekeeping: a failure there must not cost this
        // notification the shortcut that gives it the conversation treatment.
        NativeFailureGuard.run(
            "Unable to trim the Android conversation shortcuts",
            () -> trimConversationShortcuts(context, shortcutId)
        );
        boolean pushed = NativeFailureGuard.get(
            "Unable to publish the Android conversation shortcut",
            () -> {
                ShortcutInfoCompat.Builder shortcut =
                    new ShortcutInfoCompat.Builder(context, shortcutId)
                        .setLongLived(true)
                        .setPerson(person)
                        .setShortLabel(message.title)
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

    /**
     * Whether this push earns a launcher shortcut. It needs a conversation to
     * point at, and the install must not be self-hosted: the tap target is the
     * app link for the baked cloud host, which MainActivity refuses while a
     * self-hosted origin is configured, so the shortcut would only foreground
     * the app and hand its VIEW intent to the bridge as an appUrlOpen.
     */
    static boolean publishesConversationShortcut(
        @Nullable String conversationId,
        @Nullable URI selfHostedServer
    ) {
        return conversationId != null && selfHostedServer == null;
    }

    /** Drops our oldest conversation shortcuts so the new one fits within the cap. */
    private static void trimConversationShortcuts(Context context, String keptId) {
        List<String> stale = staleShortcutIds(dynamicShortcutIds(context), keptId);
        if (!stale.isEmpty()) {
            ShortcutManagerCompat.removeLongLivedShortcuts(context, stale);
        }
    }

    private static List<String> dynamicShortcutIds(Context context) {
        List<ShortcutInfoCompat> shortcuts = new ArrayList<>(
            ShortcutManagerCompat.getDynamicShortcuts(context)
        );
        shortcuts.sort(Comparator.comparingLong(ShortcutInfoCompat::getLastChangedTimestamp));
        List<String> ids = new ArrayList<>();
        for (ShortcutInfoCompat shortcut : shortcuts) {
            ids.add(shortcut.getId());
        }
        return ids;
    }

    /** Ours out of the launcher's, oldest first, minus the one being claimed. */
    static List<String> ownedShortcutIds(List<String> oldestFirst, @Nullable String keptId) {
        List<String> ours = new ArrayList<>();
        for (String id : oldestFirst) {
            if (id.startsWith(PushDataMessage.SHORTCUT_ID_PREFIX) && !id.equals(keptId)) {
                ours.add(id);
            }
        }
        return ours;
    }

    /** The oldest of ours to drop so the claimed id lands within the cap. */
    static List<String> staleShortcutIds(List<String> oldestFirst, String keptId) {
        List<String> ours = ownedShortcutIds(oldestFirst, keptId);
        int surplus = ours.size() - (MAX_CONVERSATION_SHORTCUTS - 1);
        return surplus <= 0 ? Collections.emptyList() : ours.subList(0, surplus);
    }
}
