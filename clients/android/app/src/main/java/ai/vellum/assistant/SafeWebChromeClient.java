package ai.vellum.assistant;

import android.Manifest;
import android.content.pm.PackageManager;
import android.webkit.PermissionRequest;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.ContextCompat;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** Serializes WebView microphone requests behind one Android permission prompt. */
final class SafeWebChromeClient extends BridgeWebChromeClient {
    private static final String[] AUDIO_CAPTURE = { PermissionRequest.RESOURCE_AUDIO_CAPTURE };

    private final Bridge bridge;
    private final ActivityResultLauncher<String> microphonePermissionLauncher;
    private final List<PermissionRequest> pendingMicrophoneRequests = new ArrayList<>();
    private boolean microphonePromptOpen;

    SafeWebChromeClient(Bridge bridge) {
        super(bridge);
        this.bridge = bridge;
        microphonePermissionLauncher = bridge.registerForActivityResult(
            new ActivityResultContracts.RequestPermission(),
            this::finishMicrophoneRequests
        );
    }

    @Override
    public void onPermissionRequest(PermissionRequest request) {
        if (!requestsMicrophone(request)) {
            super.onPermissionRequest(request);
            return;
        }
        if (hasMicrophonePermission()) {
            finishRequest(request, true);
            return;
        }

        pendingMicrophoneRequests.add(request);
        if (microphonePromptOpen) {
            return;
        }
        microphonePromptOpen = true;
        try {
            microphonePermissionLauncher.launch(Manifest.permission.RECORD_AUDIO);
        } catch (RuntimeException exception) {
            finishMicrophoneRequests(false);
            NativeFailureGuard.record(
                "Unable to request Android microphone permission",
                exception
            );
        }
    }

    @Override
    public void onPermissionRequestCanceled(PermissionRequest request) {
        pendingMicrophoneRequests.remove(request);
        super.onPermissionRequestCanceled(request);
    }

    private boolean requestsMicrophone(PermissionRequest request) {
        return Arrays
            .asList(request.getResources())
            .contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE);
    }

    private boolean hasMicrophonePermission() {
        return (
            ContextCompat.checkSelfPermission(
                bridge.getContext(),
                Manifest.permission.RECORD_AUDIO
            ) ==
            PackageManager.PERMISSION_GRANTED
        );
    }

    private void finishMicrophoneRequests(boolean granted) {
        microphonePromptOpen = false;
        List<PermissionRequest> requests = new ArrayList<>(pendingMicrophoneRequests);
        pendingMicrophoneRequests.clear();
        for (PermissionRequest request : requests) {
            finishRequest(request, granted);
        }
    }

    private void finishRequest(PermissionRequest request, boolean granted) {
        try {
            if (granted) {
                request.grant(AUDIO_CAPTURE);
            } else {
                request.deny();
            }
        } catch (RuntimeException exception) {
            NativeFailureGuard.record(
                "Unable to complete an Android microphone permission request",
                exception
            );
        }
    }
}
