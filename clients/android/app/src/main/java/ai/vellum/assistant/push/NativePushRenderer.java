package ai.vellum.assistant.push;

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

/**
 * Renders a data-only push. With a sender the notification is a
 * {@code MessagingStyle} conversation: the avatar is the large icon, the
 * assistant's name is the message line, and the conversation title is the
 * header. The avatar is the only optional part of that treatment. Without a
 * sender the notification matches what Firebase rendered from a notification
 * block.
 */
public final class NativePushRenderer {
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

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, message.channelId)
            .setSmallIcon(R.drawable.ic_stat_notification)
            .setColor(ContextCompat.getColor(context, R.color.notification_icon_color))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setContentIntent(contentIntent)
            .setOnlyAlertOnce(true)
            .setAutoCancel(true);
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
        // oversized payload, and the first push for a hash posts before the
        // download lands. The conversation treatment does not depend on it.
        IconCompat icon = avatar == null ? null : IconCompat.createWithBitmap(avatar);
        Person.Builder personBuilder = new Person.Builder().setKey(sender.id).setName(sender.name);
        if (icon != null) {
            personBuilder.setIcon(icon);
        }
        Person person = personBuilder.build();
        String shortcutId = PushDataMessage.shortcutId(sender.id, message.conversationId);
        pushShortcut(context, shortcutId, sender, person, icon, launchIntent);
        builder
            .setShortcutId(shortcutId)
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

        manager.notify(notificationId, builder.build());
    }

    private static void pushShortcut(
        Context context,
        String shortcutId,
        PushDataMessage.Sender sender,
        Person person,
        @Nullable IconCompat icon,
        @Nullable Intent launchIntent
    ) {
        if (launchIntent == null) {
            return;
        }
        NativeFailureGuard.run("Unable to publish the Android conversation shortcut", () -> {
            ShortcutInfoCompat.Builder shortcut =
                new ShortcutInfoCompat.Builder(context, shortcutId)
                    .setLongLived(true)
                    .setPerson(person)
                    .setShortLabel(sender.name)
                    .setIntent(launchIntent);
            if (icon != null) {
                shortcut.setIcon(icon);
            }
            ShortcutManagerCompat.pushDynamicShortcut(context, shortcut.build());
        });
    }
}
