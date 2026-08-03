package ai.vellum.assistant;

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

@CapacitorPlugin(name = "VoiceAudioSession")
public class VoiceAudioSessionPlugin extends Plugin implements AudioManager.OnAudioFocusChangeListener {
    static final String EVENT_NAME = "voiceAudioInterruption";
    private static final String FAILURE_CODE = "AUDIO_SESSION_FAILED";

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final AudioDeviceCallback deviceCallback = new AudioDeviceCallback() {
        @Override
        public void onAudioDevicesAdded(AudioDeviceInfo[] addedDevices) {
            emitRouteChange(addedDevices);
        }

        @Override
        public void onAudioDevicesRemoved(AudioDeviceInfo[] removedDevices) {
            emitRouteChange(removedDevices);
        }
    };
    private AudioFocusRequest focusRequest;
    private AudioManager audioManager;
    private boolean active;
    private boolean deviceCallbackRegistered;
    private boolean routeCallbacksReady;

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

        try {
            int result = requestAudioFocus();
            if (result != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
                call.resolve(activationResult(false));
                return;
            }
            active = true;
            audioManager.registerAudioDeviceCallback(deviceCallback, mainHandler);
            deviceCallbackRegistered = true;
            mainHandler.post(() -> routeCallbacksReady = active && deviceCallbackRegistered);
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
        stopRouteMonitoring();
        if (audioManager == null) {
            active = false;
            return;
        }
        if (active) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                audioManager.abandonAudioFocusRequest(focusRequest);
            } else {
                audioManager.abandonAudioFocus(this);
            }
        }
        active = false;
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
            stopRouteMonitoring();
        }
        notifyListeners(EVENT_NAME, event.toJSObject());
    }

    private void emitRouteChange(AudioDeviceInfo[] devices) {
        if (!active || !routeCallbacksReady) {
            return;
        }
        for (AudioDeviceInfo device : devices) {
            if (isCommunicationRoute(device.getType())) {
                notifyListeners(EVENT_NAME, FocusEvent.routeChange().toJSObject());
                return;
            }
        }
    }

    private static boolean isCommunicationRoute(int type) {
        return type == AudioDeviceInfo.TYPE_WIRED_HEADSET ||
            type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES ||
            type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
            type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP ||
            type == AudioDeviceInfo.TYPE_USB_HEADSET ||
            type == AudioDeviceInfo.TYPE_HEARING_AID;
    }

    private void stopRouteMonitoring() {
        if (audioManager != null && deviceCallbackRegistered) {
            audioManager.unregisterAudioDeviceCallback(deviceCallback);
        }
        deviceCallbackRegistered = false;
        routeCallbacksReady = false;
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

        static FocusEvent routeChange() {
            return new FocusEvent("began", "route-change");
        }

        static FocusEvent fromFocusChange(int focusChange) {
            switch (focusChange) {
                case AudioManager.AUDIOFOCUS_GAIN:
                    return new FocusEvent("ended", "resume");
                case AudioManager.AUDIOFOCUS_LOSS:
                    return new FocusEvent("began", "focus-loss");
                case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT:
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
