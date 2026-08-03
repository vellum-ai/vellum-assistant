package ai.vellum.assistant;

import android.app.AlertDialog;
import android.content.Intent;
import android.net.http.SslError;
import android.os.Bundle;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.CapConfig;
import com.getcapacitor.Logger;
import java.io.IOException;
import java.net.URI;
import org.json.JSONException;

public class MainActivity extends BridgeActivity {
    private static ConnectDeepLink recreationConnect;

    private AlertDialog unreachableDialog;
    private URI effectiveServer;
    private ConnectDeepLink pendingConnect;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        pendingConnect = takeRecreationConnect();
        if (pendingConnect == null) {
            pendingConnect = consumeConnectIntent(getIntent());
        }
        configureServer(pendingConnect == null ? SelfHostedServer.configured(this) : pendingConnect.server());
        registerPlugin(NativeAuthPlugin.class);
        registerPlugin(NativeBiometricPlugin.class);
        registerPlugin(VoiceAudioSessionPlugin.class);
        super.onCreate(savedInstanceState);
        if (bridge != null) {
            bridge.setWebViewClient(new SelfHostedWebViewClient(bridge, this));
        }
        deliverPendingConnect();
    }

    @Override
    protected void onNewIntent(Intent intent) {
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
        if (unreachableDialog != null) {
            unreachableDialog.dismiss();
            unreachableDialog = null;
        }
        super.onDestroy();
    }

    private void configureServer(URI selectedServer) {
        effectiveServer = selectedServer;
        if (selectedServer == null) {
            config = CapConfig.loadDefault(this);
            return;
        }
        try {
            config = SelfHostedServer.overrideCapacitorConfig(this, selectedServer);
        } catch (IOException | JSONException exception) {
            Logger.error("Unable to apply the self-hosted server configuration", exception);
            effectiveServer = null;
            config = CapConfig.loadDefault(this);
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
        SelfHostedServer.clear(this);
        pendingConnect = null;
        setRecreationConnect(null);
        effectiveServer = null;
        setIntent(withoutData(getIntent()));
        recreate();
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
            mainFrameUrl = url;
            mainFrameFailed = false;
            super.onPageStarted(view, url, favicon);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            if (!mainFrameFailed) {
                activity.finishPendingConnect(url);
            }
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
            activity.handleServerFailure(url);
        }
    }
}
