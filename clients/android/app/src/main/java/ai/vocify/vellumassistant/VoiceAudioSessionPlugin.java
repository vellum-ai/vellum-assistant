package ai.vocify.vellumassistant;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.HashSet;
import java.util.Set;

@CapacitorPlugin(name = "VoiceAudioSession")
public class VoiceAudioSessionPlugin extends Plugin implements AudioManager.OnAudioFocusChangeListener {
    static final String EVENT_NAME = "voiceAudioInterruption";
    private static final String FAILURE_CODE = "AUDIO_SESSION_FAILED";

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final AudioDeviceCallback deviceCallback = new AudioDeviceCallback() {
        @Override
        public void onAudioDevicesAdded(AudioDeviceInfo[] addedDevices) {
            emitRouteChange();
        }

        @Override
        public void onAudioDevicesRemoved(AudioDeviceInfo[] removedDevices) {
            emitRouteChange();
        }
    };

    private AudioFocusRequest focusRequest;
    private AudioManager audioManager;
    private boolean active;
    private boolean deviceCallbackRegistered;
    private boolean modeChanged;
    private int previousMode = AudioManager.MODE_NORMAL;
    private Set<Integer> routeDeviceIds = new HashSet<>();

    @Override
    public void load() {
        audioManager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            AudioAttributes attributes = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build();
            focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(attributes)
                .setAcceptsDelayedFocusGain(false)
                .setOnAudioFocusChangeListener(this, mainHandler)
                .setWillPauseWhenDucked(true)
                .build();
        }
    }

    @PluginMethod
    public void activate(PluginCall call) {
        runOnMainThread(() -> activateOnMain(call));
    }

    @PluginMethod
    public void deactivate(PluginCall call) {
        runOnMainThread(() -> {
            releaseAudioFocus();
            call.resolve();
        });
    }

    @Override
    protected void handleOnDestroy() {
        runOnMainThread(this::releaseAudioFocus);
    }

    @Override
    public void onAudioFocusChange(int focusChange) {
        mainHandler.post(() -> handleFocusChange(focusChange));
    }

    private void activateOnMain(PluginCall call) {
        if (audioManager == null) {
            call.reject("Android audio services are unavailable", FAILURE_CODE);
            return;
        }
        if (active) {
            call.resolve(activationResult(true));
            return;
        }

        previousMode = audioManager.getMode();
        try {
            audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
            modeChanged = true;
            int result = requestAudioFocus();
            if (result != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
                restoreAudioMode();
                call.resolve(activationResult(false));
                return;
            }
            active = true;
            routeDeviceIds = currentCommunicationRouteIds();
            audioManager.registerAudioDeviceCallback(deviceCallback, mainHandler);
            deviceCallbackRegistered = true;
            call.resolve(activationResult(true));
        } catch (RuntimeException exception) {
            releaseAudioFocus();
            call.reject("Failed to activate Android voice audio focus", FAILURE_CODE, exception);
        }
    }

    @SuppressWarnings("deprecation")
    private int requestAudioFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            return audioManager.requestAudioFocus(focusRequest);
        }
        return audioManager.requestAudioFocus(
            this,
            AudioManager.STREAM_VOICE_CALL,
            AudioManager.AUDIOFOCUS_GAIN_TRANSIENT
        );
    }

    @SuppressWarnings("deprecation")
    private void releaseAudioFocus() {
        if (audioManager == null) {
            active = false;
            return;
        }
        if (deviceCallbackRegistered) {
            audioManager.unregisterAudioDeviceCallback(deviceCallback);
            deviceCallbackRegistered = false;
            routeDeviceIds.clear();
        }
        if (active) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                audioManager.abandonAudioFocusRequest(focusRequest);
            } else {
                audioManager.abandonAudioFocus(this);
            }
        }
        active = false;
        restoreAudioMode();
    }

    private void restoreAudioMode() {
        if (audioManager != null && modeChanged) {
            audioManager.setMode(previousMode);
            modeChanged = false;
        }
    }

    private void handleFocusChange(int focusChange) {
        if (!active) {
            return;
        }
        FocusEvent event = FocusEvent.fromFocusChange(focusChange);
        if (event == null) {
            return;
        }
        if (focusChange == AudioManager.AUDIOFOCUS_LOSS) {
            active = false;
        }
        notifyListeners(EVENT_NAME, event.toJSObject());
    }

    private void emitRouteChange() {
        if (!active) {
            return;
        }
        Set<Integer> nextRouteDeviceIds = currentCommunicationRouteIds();
        if (routeDeviceIds.equals(nextRouteDeviceIds)) {
            return;
        }
        routeDeviceIds = nextRouteDeviceIds;
        JSObject event = new JSObject();
        event.put("type", "began");
        event.put("reason", "route-change");
        notifyListeners(EVENT_NAME, event);
    }

    private Set<Integer> currentCommunicationRouteIds() {
        Set<Integer> ids = new HashSet<>();
        for (
            AudioDeviceInfo device : audioManager.getDevices(
                AudioManager.GET_DEVICES_INPUTS | AudioManager.GET_DEVICES_OUTPUTS
            )
        ) {
            if (isCommunicationRouteType(device.getType())) {
                ids.add(device.getId());
            }
        }
        return ids;
    }

    private static boolean isCommunicationRouteType(int type) {
        switch (type) {
            case AudioDeviceInfo.TYPE_WIRED_HEADSET:
            case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
            case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP:
            case AudioDeviceInfo.TYPE_USB_HEADSET:
            case AudioDeviceInfo.TYPE_HEARING_AID:
                return true;
            default:
                return false;
        }
    }

    private void runOnMainThread(Runnable action) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            action.run();
        } else {
            mainHandler.post(action);
        }
    }

    private static JSObject activationResult(boolean activated) {
        JSObject result = new JSObject();
        result.put("activated", activated);
        return result;
    }

    static final class FocusEvent {
        final String type;
        final String reason;

        private FocusEvent(String type, String reason) {
            this.type = type;
            this.reason = reason;
        }

        static FocusEvent fromFocusChange(int focusChange) {
            switch (focusChange) {
                case AudioManager.AUDIOFOCUS_GAIN:
                    return new FocusEvent("ended", "resume");
                case AudioManager.AUDIOFOCUS_LOSS:
                    return new FocusEvent("began", "focus-loss");
                case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT:
                case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK:
                    return new FocusEvent("began", "interruption");
                default:
                    return null;
            }
        }

        JSObject toJSObject() {
            JSObject result = new JSObject();
            result.put("type", type);
            result.put("reason", reason);
            return result;
        }
    }
}
