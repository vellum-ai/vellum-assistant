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
 * header. Without one it matches what Firebase rendered from a notification
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
            .setAutoCancel(true);
        if (message.unreadCount != null && message.unreadCount > 0) {
            builder.setNumber(message.unreadCount);
        }

        PushDataMessage.Sender sender = message.sender;
        if (sender != null && avatar != null) {
            IconCompat icon = IconCompat.createWithBitmap(avatar);
            Person person = new Person.Builder()
                .setKey(sender.id)
                .setName(sender.name)
                .setIcon(icon)
                .build();
            pushShortcut(context, sender, person, icon, launchIntent);
            builder
                .setShortcutId(sender.id)
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
        } else {
            builder
                .setContentTitle(message.title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body));
        }

        manager.notify(notificationId, builder.build());
    }

    private static void pushShortcut(
        Context context,
        PushDataMessage.Sender sender,
        Person person,
        IconCompat icon,
        @Nullable Intent launchIntent
    ) {
        if (launchIntent == null) {
            return;
        }
        NativeFailureGuard.run("Unable to publish the Android conversation shortcut", () ->
            ShortcutManagerCompat.pushDynamicShortcut(
                context,
                new ShortcutInfoCompat.Builder(context, sender.id)
                    .setLongLived(true)
                    .setPerson(person)
                    .setShortLabel(sender.name)
                    .setIcon(icon)
                    .setIntent(launchIntent)
                    .build()
            )
        );
    }
}
