package ai.vellum.assistant;

import android.app.AlertDialog;
import android.content.Intent;
import android.net.http.SslError;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.widget.ImageView;
import com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.CapConfig;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginLoadException;
import com.getcapacitor.PluginManager;
import java.io.IOException;
import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONException;

public class MainActivity extends BridgeActivity {
    private static final long LAUNCH_SCREEN_LOAD_FALLBACK_MS = 2_000;
    private static final long LAUNCH_SCREEN_TIMEOUT_MS = 15_000;
    private static ConnectDeepLink recreationConnect;

    private final Handler launchScreenHandler = new Handler(Looper.getMainLooper());
    private AlertDialog unreachableDialog;
    private URI effectiveServer;
    private URI pendingAppLink;
    private ConnectDeepLink pendingConnect;
    private boolean pendingNewChat;
    private Intent pendingVoiceLaunch;
    private View launchScreen;
    private boolean launchScreenReady;
    private SafeWebChromeClient webChromeClient;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        NativeFailureGuard.initialize(this);
        NativeFailureGuard.run(
            "Unable to apply the Android launch theme",
            () -> NativeLaunchScreenPlugin.applySavedTheme(this)
        );
        boolean recoveredProcess = NativeFailureGuard.get(
            "Unable to clear the recovered voice status",
            () -> VoiceLiveActivityPlugin.clearRecoveredStatus(this),
            false
        );
        NativeFailureGuard.run("Unable to normalize the Android launch intent", () -> {
            if (
                VoiceDeepLink.shouldSuppressRecoveredStatusLaunch(
                    recoveredProcess,
                    VoiceDeepLink.isStatusNotificationIntent(getIntent())
                )
            ) {
                setIntent(VoiceDeepLink.clearedCommandIntent(getIntent()));
            }
        });
        NativeFailureGuard.run(
            "Unable to prepare the Android voice launch",
            () -> prepareVoiceLaunch(getIntent())
        );
        pendingConnect = NativeFailureGuard.get(
            "Unable to read the Android connect launch",
            () -> {
                ConnectDeepLink connect = takeRecreationConnect();
                return connect == null ? consumeConnectIntent(getIntent()) : connect;
            },
            null
        );
        URI selectedServer = pendingConnect == null
            ? NativeFailureGuard.get(
                "Unable to read the saved self-hosted server",
                () -> SelfHostedServer.configured(this),
                null
            )
            : pendingConnect.server();
        configureServer(selectedServer);
        pendingAppLink = NativeFailureGuard.get(
            "Unable to read the Android app link",
            () -> consumeAppLinkIntent(getIntent()),
            null
        );
        super.onCreate(savedInstanceState);
        NativeFailureGuard.run("Unable to show the Android launch screen", this::showLaunchScreen);
        NativeFailureGuard.run("Unable to deliver the Android voice launch", this::deliverPendingVoiceLaunch);
        NativeFailureGuard.run("Unable to configure the Android WebView", () -> {
            if (bridge != null) {
                webChromeClient = new SafeWebChromeClient(bridge);
                bridge.getWebView().setWebChromeClient(webChromeClient);
                bridge.setWebViewClient(new SelfHostedWebViewClient(bridge, this));
            }
        });
        NativeFailureGuard.run("Unable to deliver the Android app link", this::deliverPendingAppLink);
        NativeFailureGuard.run("Unable to deliver the Android connect launch", this::deliverPendingConnect);
        NativeFailureGuard.run("Unable to deliver the Android new chat launch", this::deliverPendingNewChat);
    }

    @Override
    protected void load() {
        List<Class<? extends Plugin>> plugins;
        try {
            plugins = new PluginManager(getAssets()).loadPluginClasses();
            plugins.removeIf(PushNotificationsPlugin.class::equals);
        } catch (PluginLoadException exception) {
            NativeFailureGuard.record("Unable to load Capacitor plugins", exception);
            plugins = new ArrayList<>();
        }
        bridgeBuilder.setPlugins(plugins);
        registerPlugin(NativeAuthPlugin.class);
        registerPlugin(NativeBiometricPlugin.class);
        registerPlugin(NativeFailureReportsPlugin.class);
        registerPlugin(NativeLaunchScreenPlugin.class);
        registerPlugin(AndroidNotificationChannelsPlugin.class);
        registerPlugin(AndroidNotificationSettingsPlugin.class);
        registerPlugin(AndroidPushRegistrationPlugin.class);
        registerPlugin(VoiceAudioSessionPlugin.class);
        registerPlugin(VoiceLiveActivityPlugin.class);
        registerPlugin(SafePushNotificationsPlugin.class);
        super.load();
    }

    private void showLaunchScreen() {
        if (launchScreenReady) {
            return;
        }
        ImageView view = new ImageView(this);
        view.setBackgroundColor(NativeLaunchScreenPlugin.backgroundColor(this));
        view.setImageResource(R.drawable.vellum_mark);
        view.setColorFilter(NativeLaunchScreenPlugin.foregroundColor(this));
        view.setScaleType(ImageView.ScaleType.CENTER);
        view.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        addContentView(
            view,
            new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        );
        launchScreen = view;
        scheduleLaunchScreenFallback(LAUNCH_SCREEN_TIMEOUT_MS);
    }

    void hideLaunchScreen() {
        launchScreenReady = true;
        launchScreenHandler.removeCallbacksAndMessages(null);
        if (launchScreen == null) {
            return;
        }
        ViewGroup parent = (ViewGroup) launchScreen.getParent();
        if (parent != null) {
            parent.removeView(launchScreen);
        }
        launchScreen = null;
    }

    private void scheduleLaunchScreenFallback(long delayMs) {
        if (launchScreenReady) {
            return;
        }
        launchScreenHandler.removeCallbacksAndMessages(null);
        launchScreenHandler.postDelayed(this::hideLaunchScreen, delayMs);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        URI appLink = consumeAppLinkIntent(intent);
        if (appLink != null) {
            super.onNewIntent(withoutData(intent));
            pendingAppLink = appLink;
            deliverPendingAppLink();
            return;
        }

        VoiceDeepLink.Command voiceCommand = VoiceDeepLink.parse(
            intent,
            getString(R.string.vellum_auth_scheme)
        );
        if (voiceCommand == VoiceDeepLink.Command.NEW_CHAT) {
            super.onNewIntent(VoiceDeepLink.clearedCommandIntent(intent));
            pendingNewChat = true;
            deliverPendingNewChat();
            return;
        }
        if (VoiceDeepLink.isVoiceCommand(voiceCommand)) {
            Intent delivered = VoiceDeepLink.needsNormalization(intent)
                ? VoiceDeepLink.normalizedVoiceIntent(
                    intent,
                    getString(R.string.vellum_auth_scheme),
                    voiceCommand
                )
                : intent;
            super.onNewIntent(delivered);
            setIntent(VoiceDeepLink.clearedCommandIntent(delivered));
            return;
        }

        boolean handlesConnect = isConnectIntent(intent);
        ConnectDeepLink connect = handlesConnect ? consumeConnectIntent(intent) : null;
        if (connect == null) {
            super.onNewIntent(intent);
            return;
        }

        super.onNewIntent(intent);

        if (effectiveServer == null || !effectiveServer.equals(connect.server())) {
            setRecreationConnect(connect);
            setIntent(withoutData(intent));
            recreate();
            return;
        }
        pendingConnect = connect;
        deliverPendingConnect();
    }

    @Override
    public void onDestroy() {
        launchScreenHandler.removeCallbacksAndMessages(null);
        if (webChromeClient != null) {
            webChromeClient.destroy();
            webChromeClient = null;
        }
        if (unreachableDialog != null) {
            unreachableDialog.dismiss();
            unreachableDialog = null;
        }
        super.onDestroy();
    }

    private void configureServer(URI selectedServer) {
        effectiveServer = selectedServer;
        try {
            config = selectedServer == null
                ? CapConfig.loadDefault(this)
                : SelfHostedServer.overrideCapacitorConfig(this, selectedServer);
        } catch (IOException | JSONException | RuntimeException exception) {
            NativeFailureGuard.record(
                "Unable to apply the self-hosted server configuration",
                exception
            );
            effectiveServer = null;
            try {
                config = CapConfig.loadDefault(this);
            } catch (RuntimeException fallbackException) {
                NativeFailureGuard.record(
                    "Unable to load the Android app configuration",
                    fallbackException
                );
                config = new CapConfig.Builder(this).create();
            }
        }
    }

    private ConnectDeepLink consumeConnectIntent(Intent intent) {
        if (!isConnectIntent(intent)) {
            return null;
        }
        String raw = intent.getDataString();
        intent.setData(null);
        setIntent(withoutData(intent));
        return ConnectDeepLink.parse(raw, getString(R.string.vellum_auth_scheme));
    }

    private boolean isConnectIntent(Intent intent) {
        return intent != null
            && ConnectDeepLink.handles(intent.getDataString(), getString(R.string.vellum_auth_scheme));
    }

    private URI consumeAppLinkIntent(Intent intent) {
        if (
            intent == null
                || !Intent.ACTION_VIEW.equals(intent.getAction())
                || effectiveServer != null
                || pendingConnect != null
        ) {
            return null;
        }
        URI appLink = AndroidAppLink.parse(
            intent.getDataString(),
            getString(R.string.vellum_auth_host)
        );
        if (appLink == null) {
            return null;
        }
        intent.setData(null);
        setIntent(withoutData(intent));
        return appLink;
    }

    private Intent withoutData(Intent intent) {
        Intent sanitized = intent == null ? new Intent() : new Intent(intent);
        sanitized.setData(null);
        return sanitized;
    }

    private void deliverPendingConnect() {
        if (pendingConnect == null || bridge == null || effectiveServer == null) {
            return;
        }
        bridge.getWebView().loadUrl(pendingConnect.pairPage().toASCIIString());
    }

    private void deliverPendingAppLink() {
        if (pendingAppLink == null || bridge == null) {
            return;
        }
        if (effectiveServer != null || pendingConnect != null) {
            pendingAppLink = null;
            return;
        }
        URI appLink = pendingAppLink;
        pendingAppLink = null;
        bridge.getWebView().loadUrl(appLink.toASCIIString());
    }

    private void finishPendingConnect(String loadedUrl) {
        if (
            pendingConnect == null ||
            !SelfHostedServer.samePage(pendingConnect.pairPage().toASCIIString(), loadedUrl)
        ) {
            return;
        }
        SelfHostedServer.store(this, pendingConnect.server());
        pendingConnect = null;
    }

    private void handleServerFailure(String failedUrl) {
        if (!SelfHostedServer.contains(effectiveServer, failedUrl)) {
            return;
        }
        if (unreachableDialog != null && unreachableDialog.isShowing()) {
            return;
        }
        if (isFinishing() || isDestroyed()) {
            return;
        }

        String host = effectiveServer.getHost();
        unreachableDialog = new AlertDialog.Builder(this)
            .setMessage("Can't load " + host + ".")
            .setPositiveButton("Retry", (dialog, which) -> retryServer())
            .setNegativeButton("Use Vellum Cloud", (dialog, which) -> useVellumCloud())
            .setOnDismissListener(dialog -> unreachableDialog = null)
            .create();
        unreachableDialog.show();
    }

    private void retryServer() {
        if (bridge == null || effectiveServer == null) {
            return;
        }
        String destination = pendingConnect == null
            ? effectiveServer.toASCIIString()
            : pendingConnect.pairPage().toASCIIString();
        bridge.getWebView().loadUrl(destination);
    }

    private void useVellumCloud() {
        VoiceLiveActivityPlugin.clearStatus(this);
        SelfHostedServer.clear(this);
        pendingConnect = null;
        pendingNewChat = false;
        setRecreationConnect(null);
        effectiveServer = null;
        setIntent(withoutData(getIntent()));
        recreate();
    }

    private void prepareVoiceLaunch(Intent intent) {
        VoiceDeepLink.Command command = VoiceDeepLink.parse(intent, getString(R.string.vellum_auth_scheme));
        if (command == VoiceDeepLink.Command.NEW_CHAT) {
            pendingNewChat = true;
            setIntent(VoiceDeepLink.clearedCommandIntent(intent));
            return;
        }
        if (!VoiceDeepLink.isVoiceCommand(command)) {
            return;
        }
        pendingVoiceLaunch = VoiceDeepLink.needsNormalization(intent)
            ? VoiceDeepLink.normalizedVoiceIntent(
                intent,
                getString(R.string.vellum_auth_scheme),
                command
            )
            : new Intent(intent);
        setIntent(VoiceDeepLink.clearedCommandIntent(intent));
    }

    private void deliverPendingVoiceLaunch() {
        if (pendingVoiceLaunch == null) {
            return;
        }
        Intent launch = pendingVoiceLaunch;
        pendingVoiceLaunch = null;
        super.onNewIntent(launch);
    }

    private void deliverPendingNewChat() {
        if (!pendingNewChat || bridge == null || bridge.getServerUrl() == null) {
            return;
        }
        pendingNewChat = false;
        bridge.getWebView().loadUrl(bridge.getServerUrl());
    }

    private static synchronized ConnectDeepLink takeRecreationConnect() {
        ConnectDeepLink connect = recreationConnect;
        recreationConnect = null;
        return connect;
    }

    private static synchronized void setRecreationConnect(ConnectDeepLink connect) {
        recreationConnect = connect;
    }

    private static final class SelfHostedWebViewClient extends BridgeWebViewClient {
        private final MainActivity activity;
        private String mainFrameUrl;
        private boolean mainFrameFailed;

        SelfHostedWebViewClient(Bridge bridge, MainActivity activity) {
            super(bridge);
            this.activity = activity;
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            VoiceAudioSessionPlugin.releaseForPageLoad(activity);
            activity.scheduleLaunchScreenFallback(LAUNCH_SCREEN_TIMEOUT_MS);
            mainFrameUrl = url;
            mainFrameFailed = false;
            super.onPageStarted(view, url, favicon);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            if (!mainFrameFailed) {
                activity.finishPendingConnect(url);
                activity.scheduleLaunchScreenFallback(LAUNCH_SCREEN_LOAD_FALLBACK_MS);
            }
        }

        @Override
        public boolean onRenderProcessGone(
            WebView view,
            android.webkit.RenderProcessGoneDetail detail
        ) {
            VoiceAudioSessionPlugin.releaseForPageLoad(activity);
            return super.onRenderProcessGone(view, detail);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            super.onReceivedError(view, request, error);
            if (request.isForMainFrame()) {
                fail(request.getUrl().toString());
            }
        }

        @Override
        public void onReceivedHttpError(
            WebView view,
            WebResourceRequest request,
            WebResourceResponse errorResponse
        ) {
            super.onReceivedHttpError(view, request, errorResponse);
            if (request.isForMainFrame()) {
                fail(request.getUrl().toString());
            }
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            super.onReceivedSslError(view, handler, error);
            if (SelfHostedServer.samePage(error.getUrl(), mainFrameUrl)) {
                fail(error.getUrl());
            }
        }

        private void fail(String url) {
            mainFrameFailed = true;
            activity.hideLaunchScreen();
            activity.handleServerFailure(url);
        }
    }
}
