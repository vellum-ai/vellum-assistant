package ai.vellum.assistant;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "VoiceLiveActivity")
public class VoiceLiveActivityPlugin extends Plugin {
    private static final String CHANNEL_ID = "voice_session_status";
    private static final int NOTIFICATION_ID = 4101;
    private static boolean processInitialized;

    private NotificationManager notificationManager;
    private String assistantName;
    private boolean running;

    enum Status {
        IDLE(false),
        LISTENING(false),
        THINKING(false),
        SPEAKING(false),
        TERMINAL(true);

        final boolean terminal;

        Status(boolean terminal) {
            this.terminal = terminal;
        }

        static Status fromPhase(String phase) {
            if (phase == null) {
                return null;
            }
            switch (phase) {
                case "connecting":
                    return IDLE;
                case "listening":
                    return LISTENING;
                case "transcribing":
                case "thinking":
                    return THINKING;
                case "speaking":
                    return SPEAKING;
                case "idle":
                case "ending":
                case "failed":
                    return TERMINAL;
                default:
                    return null;
            }
        }
    }

    @Override
    public void load() {
        notificationManager = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        createChannel();
    }

    @PluginMethod
    public void start(PluginCall call) {
        Status status = Status.fromPhase(call.getString("phase"));
        if (status == null) {
            resolveStarted(call, false);
            return;
        }
        if (status.terminal || !canPostNotifications()) {
            stopStatus();
            resolveStarted(call, false);
            return;
        }
        assistantName = trimmedOrDefault(
            call.getString("assistantName"),
            getContext().getString(R.string.voice_notification_title)
        );
        try {
            notificationManager.notify(NOTIFICATION_ID, buildNotification(call, status));
            running = true;
            resolveStarted(call, true);
        } catch (RuntimeException exception) {
            stopStatus();
            resolveStarted(call, false);
        }
    }

    @PluginMethod
    public void update(PluginCall call) {
        Status status = Status.fromPhase(call.getString("phase"));
        if (status == null) {
            call.resolve();
            return;
        }
        if (status.terminal) {
            stopStatus();
            call.resolve();
            return;
        }
        if (!running || !canPostNotifications()) {
            call.resolve();
            return;
        }
        try {
            notificationManager.notify(NOTIFICATION_ID, buildNotification(call, status));
        } catch (RuntimeException exception) {
            stopStatus();
        }
        call.resolve();
    }

    @PluginMethod
    public void end(PluginCall call) {
        stopStatus();
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        stopStatus();
    }

    static synchronized void clearRecoveredStatus(Context context) {
        if (processInitialized) {
            return;
        }
        processInitialized = true;
        clearStatus(context);
    }

    static void clearStatus(Context context) {
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.cancel(NOTIFICATION_ID);
        }
    }

    private Notification buildNotification(PluginCall call, Status status) {
        boolean requestPromotion = Build.VERSION.SDK_INT >= Build.VERSION_CODES.BAKLAVA
            && notificationManager.canPostPromotedNotifications();
        Notification notification = notificationBuilder(call, status, requestPromotion).build();
        if (
            requestPromotion
                && Build.VERSION.SDK_INT >= Build.VERSION_CODES.BAKLAVA
                && !notification.hasPromotableCharacteristics()
        ) {
            notification = notificationBuilder(call, status, false).build();
        }
        return notification;
    }

    private NotificationCompat.Builder notificationBuilder(PluginCall call, Status status, boolean requestPromotion) {
        String label = trimmedOrDefault(call.getString("label"), labelFor(status));
        return new NotificationCompat.Builder(getContext(), CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_voice)
            .setContentTitle(assistantName)
            .setContentText(label)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(label))
            .setContentIntent(VoiceDeepLink.resumePendingIntent(getContext()))
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .setAutoCancel(false)
            .setShowWhen(false)
            .setShortcutId("start_voice")
            .setRequestPromotedOngoing(requestPromotion);
    }

    private boolean canPostNotifications() {
        return notificationManager != null
            && (
                Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                    || ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
                        == PackageManager.PERMISSION_GRANTED
            );
    }

    private void createChannel() {
        if (notificationManager == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            getContext().getString(R.string.voice_notification_channel),
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription(getContext().getString(R.string.voice_notification_channel_description));
        channel.setShowBadge(false);
        notificationManager.createNotificationChannel(channel);
    }

    private String labelFor(Status status) {
        switch (status) {
            case LISTENING:
                return getContext().getString(R.string.voice_status_listening);
            case THINKING:
                return getContext().getString(R.string.voice_status_thinking);
            case SPEAKING:
                return getContext().getString(R.string.voice_status_speaking);
            default:
                return getContext().getString(R.string.voice_status_idle);
        }
    }

    private static String trimmedOrDefault(String value, String fallback) {
        if (value == null || value.trim().isEmpty()) {
            return fallback;
        }
        return value.trim();
    }

    private void stopStatus() {
        clearStatus(getContext());
        assistantName = null;
        running = false;
    }

    private static void resolveStarted(PluginCall call, boolean started) {
        JSObject result = new JSObject();
        result.put("started", started);
        call.resolve(result);
    }
}
