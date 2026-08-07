package ai.vellum.assistant;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

public final class VoiceModeService extends Service {
    private static final String CHANNEL_ID = "voice_session_status";
    private static final int NOTIFICATION_ID = 4101;
    private static final Object STATUS_LOCK = new Object();

    private static volatile VoiceModeService activeService;
    private static String currentAssistantName;
    private static String currentLabel;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private NotificationManager notificationManager;

    static void start(Context context) {
        ContextCompat.startForegroundService(
            context.getApplicationContext(),
            new Intent(context, VoiceModeService.class)
        );
    }

    static void stop(Context context) {
        clearStatusValues();
        context.getApplicationContext().stopService(new Intent(context, VoiceModeService.class));
    }

    static void updateStatus(String assistantName, String label) {
        synchronized (STATUS_LOCK) {
            currentAssistantName = assistantName;
            currentLabel = label;
        }
        refreshActiveNotification();
    }

    static void clearStatus() {
        clearStatusValues();
    }

    static void clearRecoveredNotification(Context context) {
        clearStatusValues();
        NotificationManager manager = (NotificationManager) context.getSystemService(
            Context.NOTIFICATION_SERVICE
        );
        if (manager != null) {
            manager.cancel(NOTIFICATION_ID);
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        notificationManager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        createChannel();
        activeService = this;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        showForegroundNotification();
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        if (activeService == this) {
            activeService = null;
        }
        mainHandler.removeCallbacksAndMessages(null);
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private static void clearStatusValues() {
        synchronized (STATUS_LOCK) {
            currentAssistantName = null;
            currentLabel = null;
        }
    }

    private static void refreshActiveNotification() {
        VoiceModeService service = activeService;
        if (service != null) {
            service.mainHandler.post(service::showForegroundNotification);
        }
    }

    private void showForegroundNotification() {
        try {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                buildNotification(),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            );
        } catch (RuntimeException exception) {
            NativeFailureGuard.record("Unable to keep voice mode active in the background", exception);
            stopSelf();
        }
    }

    private Notification buildNotification() {
        String assistantName;
        String label;
        synchronized (STATUS_LOCK) {
            assistantName = currentAssistantName;
            label = currentLabel;
        }
        String title = trimmedOrDefault(
            assistantName,
            getString(R.string.voice_notification_title)
        );
        String text = trimmedOrDefault(label, getString(R.string.voice_status_idle));
        boolean requestPromotion = Build.VERSION.SDK_INT >= Build.VERSION_CODES.BAKLAVA
            && notificationManager != null
            && notificationManager.canPostPromotedNotifications();
        Notification notification = notificationBuilder(title, text, requestPromotion).build();
        if (
            requestPromotion
                && Build.VERSION.SDK_INT >= Build.VERSION_CODES.BAKLAVA
                && !notification.hasPromotableCharacteristics()
        ) {
            notification = notificationBuilder(title, text, false).build();
        }
        return notification;
    }

    private NotificationCompat.Builder notificationBuilder(
        String title,
        String label,
        boolean requestPromotion
    ) {
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_voice)
            .setContentTitle(title)
            .setContentText(label)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(label))
            .setContentIntent(VoiceDeepLink.resumePendingIntent(this))
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

    private void createChannel() {
        if (notificationManager == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            getString(R.string.voice_notification_channel),
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription(getString(R.string.voice_notification_channel_description));
        channel.setShowBadge(false);
        notificationManager.createNotificationChannel(channel);
    }

    static String trimmedOrDefault(String value, String fallback) {
        if (value == null || value.trim().isEmpty()) {
            return fallback;
        }
        return value.trim();
    }
}
