package ai.vellum.assistant;

import android.Manifest;
import android.content.pm.PackageManager;
import android.webkit.PermissionRequest;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.ContextCompat;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.ArrayList;
import java.util.List;

/** Serializes audio-only WebView requests behind one Android permission prompt. */
final class SafeWebChromeClient extends BridgeWebChromeClient {
    private static final String[] AUDIO_CAPTURE = { PermissionRequest.RESOURCE_AUDIO_CAPTURE };

    private final URI appOrigin;
    private final Bridge bridge;
    private final ActivityResultLauncher<String> microphonePermissionLauncher;
    private final List<PermissionRequest> pendingMicrophoneRequests = new ArrayList<>();
    private boolean destroyed;
    private boolean microphonePromptOpen;

    SafeWebChromeClient(Bridge bridge) {
        super(bridge);
        this.bridge = bridge;
        appOrigin = parseOrigin(bridge.getAppUrl());
        microphonePermissionLauncher = bridge.registerForActivityResult(
            new ActivityResultContracts.RequestPermission(),
            this::finishMicrophoneRequests
        );
    }

    @Override
    public void onPermissionRequest(PermissionRequest request) {
        if (destroyed) {
            finishRequest(request, false);
            return;
        }
        if (!requestsMicrophone(request)) {
            super.onPermissionRequest(request);
            return;
        }
        if (!isAppOrigin(request)) {
            finishRequest(request, false);
            return;
        }
        if (!requestsOnlyMicrophone(request)) {
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

    void destroy() {
        if (destroyed) {
            return;
        }
        destroyed = true;
        try {
            microphonePermissionLauncher.unregister();
        } catch (RuntimeException exception) {
            NativeFailureGuard.record(
                "Unable to close the Android microphone permission launcher",
                exception
            );
        }
        finishMicrophoneRequests(false);
    }

    private boolean requestsMicrophone(PermissionRequest request) {
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                return true;
            }
        }
        return false;
    }

    private boolean requestsOnlyMicrophone(PermissionRequest request) {
        String[] resources = request.getResources();
        return resources.length == 1 &&
            PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resources[0]);
    }

    private boolean isAppOrigin(PermissionRequest request) {
        android.net.Uri rawOrigin = request.getOrigin();
        URI requestOrigin = rawOrigin == null ? null : parseOrigin(rawOrigin.toString());
        return (
            appOrigin != null &&
            requestOrigin != null &&
            appOrigin.getScheme().equalsIgnoreCase(requestOrigin.getScheme()) &&
            appOrigin.getHost().equalsIgnoreCase(requestOrigin.getHost()) &&
            effectivePort(appOrigin) == effectivePort(requestOrigin)
        );
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

    private static URI parseOrigin(String raw) {
        if (raw == null) {
            return null;
        }
        try {
            URI parsed = new URI(raw);
            return parsed.getScheme() == null || parsed.getHost() == null ? null : parsed;
        } catch (URISyntaxException exception) {
            return null;
        }
    }

    private static int effectivePort(URI origin) {
        if (origin.getPort() >= 0) {
            return origin.getPort();
        }
        if ("https".equalsIgnoreCase(origin.getScheme())) {
            return 443;
        }
        if ("http".equalsIgnoreCase(origin.getScheme())) {
            return 80;
        }
        return -1;
    }
}
