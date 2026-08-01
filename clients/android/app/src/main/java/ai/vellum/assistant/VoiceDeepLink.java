package ai.vellum.assistant;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import java.net.URI;
import java.net.URISyntaxException;

final class VoiceDeepLink {
    static final String ACTION_NEW_CHAT = "ai.vellum.assistant.action.NEW_CHAT";
    static final String ACTION_OPEN_FEATURE = "ai.vellum.assistant.action.OPEN_FEATURE";
    static final String ACTION_RESUME_VOICE = "ai.vellum.assistant.action.RESUME_VOICE";
    static final String ACTION_START_VOICE = "ai.vellum.assistant.action.START_VOICE";
    static final String EXTRA_FEATURE = "feature";
    static final String EXTRA_STATUS_NOTIFICATION = "voice_status_notification";
    static final String FEATURE_NEW_CHAT = "new_chat";
    static final String FEATURE_VOICE_MODE = "voice_mode";

    private static final String VOICE_HOST = "voice";
    private static final int RESUME_REQUEST_CODE = 4102;

    enum Command {
        NONE,
        NEW_CHAT,
        START_VOICE,
        RESUME_VOICE,
    }

    private VoiceDeepLink() {}

    static Command parse(Intent intent, String expectedScheme) {
        return intent == null
            ? Command.NONE
            : parse(intent.getAction(), intent.getDataString(), intent.getStringExtra(EXTRA_FEATURE), expectedScheme);
    }

    static Command parse(String action, String rawUrl, String feature, String expectedScheme) {
        if (ACTION_NEW_CHAT.equals(action)) {
            return Command.NEW_CHAT;
        }
        if (ACTION_START_VOICE.equals(action)) {
            return Command.START_VOICE;
        }
        if (ACTION_RESUME_VOICE.equals(action)) {
            return Command.RESUME_VOICE;
        }
        if (ACTION_OPEN_FEATURE.equals(action)) {
            if (FEATURE_NEW_CHAT.equals(feature)) {
                return Command.NEW_CHAT;
            }
            if (FEATURE_VOICE_MODE.equals(feature)) {
                return Command.START_VOICE;
            }
            return Command.NONE;
        }
        return parseExternal(rawUrl, expectedScheme);
    }

    static boolean needsNormalization(Intent intent) {
        if (intent == null) {
            return false;
        }
        String action = intent.getAction();
        return ACTION_START_VOICE.equals(action)
            || ACTION_RESUME_VOICE.equals(action)
            || ACTION_OPEN_FEATURE.equals(action);
    }

    static boolean isVoiceCommand(Command command) {
        return command == Command.START_VOICE || command == Command.RESUME_VOICE;
    }

    static boolean shouldSuppressRecoveredStatusLaunch(boolean recoveredProcess, boolean statusNotification) {
        return recoveredProcess && statusNotification;
    }

    static boolean isStatusNotificationIntent(Intent intent) {
        return intent != null && intent.getBooleanExtra(EXTRA_STATUS_NOTIFICATION, false);
    }

    static Intent normalizedVoiceIntent(Intent source, String scheme, Command command) {
        Intent normalized = new Intent(source == null ? new Intent() : source);
        normalized.setAction(Intent.ACTION_VIEW);
        normalized.setData(Uri.parse(voiceUrl(scheme, command)));
        normalized.removeExtra(EXTRA_FEATURE);
        return normalized;
    }

    static Intent clearedCommandIntent(Intent source) {
        Intent cleared = new Intent(source == null ? new Intent() : source);
        cleared.setAction(Intent.ACTION_MAIN);
        cleared.setData(null);
        cleared.removeExtra(EXTRA_FEATURE);
        cleared.removeExtra(EXTRA_STATUS_NOTIFICATION);
        return cleared;
    }

    static Intent startVoiceIntent(Context context) {
        return commandIntent(context, ACTION_START_VOICE);
    }

    static PendingIntent resumePendingIntent(Context context) {
        Intent intent = commandIntent(context, ACTION_RESUME_VOICE).putExtra(EXTRA_STATUS_NOTIFICATION, true);
        return PendingIntent.getActivity(
            context,
            RESUME_REQUEST_CODE,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    static String voiceUrl(String scheme, Command command) {
        String mode = command == Command.RESUME_VOICE ? "resume" : "new";
        return scheme + "://" + VOICE_HOST + "?mode=" + mode;
    }

    private static Intent commandIntent(Context context, String action) {
        return new Intent(context, MainActivity.class)
            .setAction(action)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    }

    private static Command parseExternal(String rawUrl, String expectedScheme) {
        if (rawUrl == null || expectedScheme == null) {
            return Command.NONE;
        }
        final URI uri;
        try {
            uri = new URI(rawUrl);
        } catch (URISyntaxException exception) {
            return Command.NONE;
        }
        if (!expectedScheme.equalsIgnoreCase(uri.getScheme()) || !VOICE_HOST.equalsIgnoreCase(uri.getHost())) {
            return Command.NONE;
        }
        String path = uri.getPath();
        if (path != null && !path.isEmpty() && !"/".equals(path)) {
            return Command.NONE;
        }
        String query = uri.getRawQuery();
        if (query != null) {
            for (String part : query.split("&")) {
                if ("mode=resume".equals(part)) {
                    return Command.RESUME_VOICE;
                }
            }
        }
        return Command.START_VOICE;
    }
}
