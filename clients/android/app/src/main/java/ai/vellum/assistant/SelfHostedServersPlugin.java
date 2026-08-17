package ai.vellum.assistant;

import android.app.Activity;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.net.URI;
import java.util.List;

/**
 * Exposes the remembered self-hosted server list to the web chooser,
 * mirroring iOS's {@code SelfHostedServersPlugin.swift}. Per the skew rule in
 * {@code clients/web/docs/CAPACITOR.md}, one result shape encodes every
 * state: empty state resolves with an empty list and nulls; only an
 * {@code add}/{@code switchTo}/{@code switchToPath} url failing
 * {@link SelfHostedServer#validate} (or a malformed switchToPath path)
 * rejects.
 */
@CapacitorPlugin(name = "SelfHostedServers")
public class SelfHostedServersPlugin extends Plugin {

    @PluginMethod
    public void list(PluginCall call) {
        URI active = SelfHostedServer.configured(getContext());
        call.resolve(
            listPayload(
                SelfHostedServer.servers(getContext()),
                active == null ? null : active.toASCIIString(),
                SelfHostedServer.bakedServerUrl(getContext())
            )
        );
    }

    static JSObject listPayload(List<SelfHostedServer.Entry> servers, String activeUrl, String bakedUrl) {
        JSArray items = new JSArray();
        for (SelfHostedServer.Entry entry : servers) {
            JSObject item = new JSObject();
            if (entry.name != null) {
                item.put("name", entry.name);
            }
            item.put("url", entry.url);
            items.put(item);
        }
        JSObject payload = new JSObject();
        payload.put("servers", items);
        payload.put("activeUrl", activeUrl == null ? JSObject.NULL : activeUrl);
        payload.put("bakedUrl", bakedUrl == null ? JSObject.NULL : bakedUrl);
        return payload;
    }

    @PluginMethod
    public void add(PluginCall call) {
        URI url = SelfHostedServer.validate(call.getString("url"));
        if (url == null) {
            call.reject("invalid url");
            return;
        }
        SelfHostedServer.append(getContext(), url, call.getString("name"));
        call.resolve(okResult());
    }

    /**
     * Forgetting a url that is not (or cannot be) in the list is a no-op, so
     * this never rejects. Removing the active server clears the active slot,
     * so the shell recreates back to the baked origin like {@code switchTo({})}.
     */
    @PluginMethod
    public void remove(PluginCall call) {
        URI url = SelfHostedServer.validate(call.getString("url"));
        boolean removedActive = url != null && SelfHostedServer.removeEntry(getContext(), url);
        // Resolve before scheduling the recreate: recreation tears the bridge
        // down, so a web caller awaiting this call would otherwise never settle.
        call.resolve(okResult());
        if (removedActive) {
            scheduleRecreate(null);
        }
    }

    /**
     * Switching to a url implies remembering it, so the target is appended to
     * the list alongside the active-slot write (nameless, keeping any stored
     * label). An absent or empty url returns to the baked origin. Always
     * recreates, even onto the same origin, matching iOS's unconditional
     * reload.
     */
    @PluginMethod
    public void switchTo(PluginCall call) {
        if (!applySwitchUrl(call)) {
            return;
        }
        // Same ordering constraint as remove: settle the call, then recreate.
        call.resolve(okResult());
        scheduleRecreate(null);
    }

    /**
     * switchTo plus an initial in-app route under the destination's entry
     * URL, mirroring iOS. An invalid path rejects before any state changes.
     */
    @PluginMethod
    public void switchToPath(PluginCall call) {
        String raw = call.getString("path");
        String path = raw == null ? "" : raw.trim();
        if (!SelfHostedServer.isRoutePathShape(path)) {
            call.reject("invalid path");
            return;
        }
        if (!applySwitchUrl(call)) {
            return;
        }
        call.resolve(okResult());
        scheduleRecreate(path);
    }

    /**
     * Shared switchTo/switchToPath url handling: absent or empty returns to
     * the baked origin; a valid url is stored and remembered nameless,
     * keeping any stored label; invalid rejects and returns false.
     */
    private boolean applySwitchUrl(PluginCall call) {
        String raw = call.getString("url");
        String trimmed = raw == null ? "" : raw.trim();
        if (trimmed.isEmpty()) {
            SelfHostedServer.clear(getContext());
            return true;
        }
        URI url = SelfHostedServer.validate(trimmed);
        if (url == null) {
            call.reject("invalid url");
            return false;
        }
        SelfHostedServer.activate(getContext(), url, null);
        return true;
    }

    private void scheduleRecreate(String routePath) {
        Activity activity = getActivity();
        if (activity instanceof MainActivity mainActivity) {
            activity.runOnUiThread(() -> {
                // A superseded activity must not consume or plant recreation state.
                if (mainActivity.isFinishing() || mainActivity.isDestroyed()) {
                    return;
                }
                mainActivity.recreateForServerChange(routePath);
            });
        }
    }

    private static JSObject okResult() {
        return new JSObject().put("ok", true);
    }
}
