package ai.vellum.assistant;

import android.content.Context;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "VoiceLiveActivity")
public class VoiceLiveActivityPlugin extends Plugin {
    private static boolean processInitialized;

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

    @PluginMethod
    public void start(PluginCall call) {
        Status status = Status.fromPhase(call.getString("phase"));
        if (status == null) {
            resolveStarted(call, false);
            return;
        }
        if (status.terminal) {
            stopStatus();
            resolveStarted(call, false);
            return;
        }
        assistantName = VoiceModeService.trimmedOrDefault(
            call.getString("assistantName"),
            getContext().getString(R.string.voice_notification_title)
        );
        VoiceModeService.updateStatus(
            assistantName,
            VoiceModeService.trimmedOrDefault(call.getString("label"), labelFor(status))
        );
        running = true;
        resolveStarted(call, true);
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
        if (!running) {
            call.resolve();
            return;
        }
        VoiceModeService.updateStatus(
            assistantName,
            VoiceModeService.trimmedOrDefault(call.getString("label"), labelFor(status))
        );
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

    static synchronized boolean clearRecoveredStatus(Context context) {
        if (processInitialized) {
            return false;
        }
        processInitialized = true;
        clearStatus(context);
        return true;
    }

    static void clearStatus(Context context) {
        VoiceModeService.clearRecoveredNotification(context);
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

    private void stopStatus() {
        VoiceModeService.clearStatus();
        assistantName = null;
        running = false;
    }

    private static void resolveStarted(PluginCall call, boolean started) {
        JSObject result = new JSObject();
        result.put("started", started);
        call.resolve(result);
    }
}
