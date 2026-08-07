package ai.vellum.assistant;

import android.app.Activity;
import com.getcapacitor.CapConfig;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.net.URI;
import org.json.JSONObject;

/**
 * Capacitor plugin exposing the remembered self-hosted server list to the web
 * layer, which installs it as the assistant chooser's storage provider. The
 * active slot stays the one the connect deep link writes; this plugin
 * generalizes it into a switchable {@code {name?, url}} list. Mirrors iOS's
 * {@code SelfHostedServersPlugin.swift} method for method.
 *
 * Per the skew rule in {@code clients/web/docs/CAPACITOR.md}, one result shape
 * encodes every state: empty state resolves with an empty list and nulls rather
 * than rejecting, so only genuinely invalid caller input (an {@code add} or
 * {@code switchTo} url failing {@link SelfHostedServer#validate}) rejects.
 */
@CapacitorPlugin(name = "SelfHostedServers")
public class SelfHostedServersPlugin extends Plugin {

    @PluginMethod
    public void list(PluginCall call) {
        JSArray servers = new JSArray();
        for (SelfHostedServer.Entry entry : SelfHostedServer.servers(getContext())) {
            JSObject item = new JSObject();
            item.put("url", entry.url);
            if (entry.name != null) {
                item.put("name", entry.name);
            }
            servers.put(item);
        }
        URI active = SelfHostedServer.configured(getContext());
        JSObject result = new JSObject();
        result.put("servers", servers);
        result.put("activeUrl", nullable(active == null ? null : active.toASCIIString()));
        result.put("bakedUrl", nullable(bakedServerUrl()));
        call.resolve(result);
    }

    @PluginMethod
    public void add(PluginCall call) {
        URI server = SelfHostedServer.validate(call.getString("url"));
        if (server == null) {
            call.reject("invalid url");
            return;
        }
        SelfHostedServer.append(getContext(), server, call.getString("name"));
        call.resolve(ok());
    }

    /**
     * Forgetting a url that is not (or cannot be) in the list is a no-op, so this
     * never rejects. Removing the active server clears the active slot, so the
     * shell reloads back to the baked origin like {@code switchTo({})}.
     */
    @PluginMethod
    public void remove(PluginCall call) {
        boolean removedActive = SelfHostedServer.remove(
            getContext(),
            SelfHostedServer.validate(call.getString("url"))
        );
        // Resolve before scheduling the reload: it recreates the activity and
        // tears the web context down, so a caller awaiting this call would
        // otherwise never settle.
        call.resolve(ok());
        if (removedActive) {
            reloadConfiguredOrigin(null);
        }
    }

    /**
     * Switching to a url implies remembering it, so the target joins the list
     * alongside the active-slot write. An absent or empty url returns the shell
     * to its baked Vellum Cloud origin.
     */
    @PluginMethod
    public void switchTo(PluginCall call) {
        if (applyOrigin(call)) {
            call.resolve(ok());
            reloadConfiguredOrigin(null);
        }
    }

    /**
     * {@link #switchTo} that also lands on a route relative to the assistant app
     * entry, so abandoning a flow on one origin arrives somewhere specific on
     * another rather than at the entry's own redirect.
     */
    @PluginMethod
    public void switchToPath(PluginCall call) {
        String route = SelfHostedServer.routePath(call.getString("path"));
        if (route == null) {
            call.reject("invalid path");
            return;
        }
        if (applyOrigin(call)) {
            call.resolve(ok());
            reloadConfiguredOrigin(route);
        }
    }

    /**
     * Point the active slot at the call's url, or clear it when the url is
     * absent or empty. Answers whether the caller should go on to reload;
     * rejects the call itself when it should not, so the shell never recreates
     * onto an origin it failed to record.
     */
    private boolean applyOrigin(PluginCall call) {
        String raw = call.getString("url");
        if (raw == null || raw.trim().isEmpty()) {
            SelfHostedServer.clear(getContext());
            return true;
        }
        URI server = SelfHostedServer.validate(raw.trim());
        if (server == null) {
            call.reject("invalid url");
            return false;
        }
        if (!SelfHostedServer.store(getContext(), server)) {
            call.reject("unable to save the server");
            return false;
        }
        SelfHostedServer.append(getContext(), server, null);
        return true;
    }

    /**
     * The Vellum Cloud origin this build ships with, read from the packaged
     * Capacitor config rather than the running one so an active self-hosted
     * override cannot mask it.
     */
    private String bakedServerUrl() {
        return NativeFailureGuard.get(
            "Unable to read the baked Android server url",
            () -> CapConfig.loadDefault(getContext()).getServerUrl(),
            null
        );
    }

    private void reloadConfiguredOrigin(String route) {
        Activity activity = getActivity();
        if (!(activity instanceof MainActivity)) {
            return;
        }
        activity.runOnUiThread(() -> ((MainActivity) activity).applyConfiguredOrigin(route));
    }

    private static JSObject ok() {
        return new JSObject().put("ok", true);
    }

    private static Object nullable(String value) {
        return value == null ? JSONObject.NULL : value;
    }
}
