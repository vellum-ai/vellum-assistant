package ai.vellum.assistant;

import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Exposes the alternate launcher icons this build ships, mirroring
 * {@code clients/ios/App/App/AppIconPlugin.swift} so
 * {@code clients/web/src/runtime/app-icon.ts} drives both shells through one
 * contract: {@code getState} resolves {@code {supported, current, available}}
 * and {@code set} resolves {@code {ok}} plus an {@code error} when it refuses.
 *
 * Android reads the launcher icon off whichever launcher component is enabled,
 * so an icon swap enables one {@code <activity-alias>} and disables the rest.
 * The only components ever toggled are the primary alias and the generated
 * {@code ai.vellum.assistant.icon.avatar_eyes_*} alternates:
 * {@code MainActivity} carries the deep links and the shortcuts source, and
 * stays enabled so shortcuts, the voice notification, and the Quick Settings
 * tile resolve in every icon state, and any other activity that lands in the
 * {@code ai.vellum.assistant.icon.} namespace is left alone. The primary alias
 * is the default artwork rather than a pickable icon, so it is absent from
 * {@code available} and reads back as a null {@code current}.
 *
 * Enabled-state scheme: the primary alias sits at
 * {@code COMPONENT_ENABLED_STATE_DEFAULT}, which the manifest defines as
 * enabled, except while an alternate is active, when it is explicitly disabled.
 * Alternates are explicitly enabled or disabled, so an alternate reading back
 * as {@code COMPONENT_ENABLED_STATE_ENABLED} is the applied icon.
 *
 * An enabled-state override outlives the install that wrote it, so exactly one
 * declared alias drawing the app is an invariant {@link #load()} enforces on
 * every start: when none of them draws it, the primary alias goes back to
 * {@code COMPONENT_ENABLED_STATE_DEFAULT}. That is the shape of a device
 * holding an explicit disable on the primary and an applied alternate this
 * build does not declare, which otherwise leaves no launcher entry at all.
 *
 * Toggling a launcher component makes the launcher re-resolve the app, which
 * some launchers answer by dropping the running task. So {@code set} only
 * records the target and {@link #handleOnStop()} applies it once the activity
 * has left the screen. {@link #load()} runs the same reconcile, so a process
 * death between the two never strands a recorded target, and it runs before the
 * activity is resumed. Until the toggle lands, {@code getState} reports the
 * recorded target as {@code current}, so the web layer's post-apply re-read
 * sees the icon it asked for.
 *
 * Per the skew rule in {@code clients/web/docs/CAPACITOR.md}, one result shape
 * encodes every state and neither method rejects: a device or build with no
 * alternates resolves {@code supported: false} with an empty {@code available},
 * and a platform below API 26 or a name this build cannot draw resolves
 * {@code {ok: false, error}}.
 */
@CapacitorPlugin(name = "AppIcon")
public class AppIconPlugin extends Plugin {
    /** Java namespace the generated aliases sit under, flavor independent. */
    static final String ALIAS_PREFIX = "ai.vellum.assistant.icon.";

    /** The launcher entry drawn with the default artwork. Not a wire icon. */
    static final String PRIMARY_ALIAS = ALIAS_PREFIX + "primary";

    /**
     * Class-name prefix every pickable alternate carries. The namespace is
     * wider than the icon set, so matching the generated prefix rather than the
     * namespace keeps an alias added for anything else out of
     * {@code available} and out of the toggles an apply performs.
     */
    static final String ALTERNATE_PREFIX = ALIAS_PREFIX + "avatar_eyes_";

    private static final String UNKNOWN_ICON_ERROR = "unknown app icon";
    private static final String UNSUPPORTED_ERROR = "app icons need API 26";
    private static final String PREFERENCES = "app_icon";
    private static final String PENDING_ALIAS_KEY = "pending_alias";
    private static final String FAILURE_CODE = "APP_ICON_FAILED";
    private static final String FAILURE_MESSAGE = "The Android app icon is unavailable";

    @Override
    public void load() {
        NativeFailureGuard.run(
            "Unable to reconcile the Android app icon",
            this::reconcileLauncherAliases
        );
    }

    @PluginMethod
    public void getState(PluginCall call) {
        NativeFailureGuard.call(call, FAILURE_MESSAGE, FAILURE_CODE, () -> {
            List<String> aliases = aliasClassNames();
            List<String> available = wireNames(aliases);
            call.resolve(
                statePayload(
                    supportsAlternateIcons(Build.VERSION.SDK_INT) && !available.isEmpty(),
                    currentWireName(pendingAlias(), enabledAlternateAlias(aliases)),
                    available
                )
            );
        });
    }

    @PluginMethod
    public void set(PluginCall call) {
        NativeFailureGuard.call(call, FAILURE_MESSAGE, FAILURE_CODE, () -> {
            String target = targetAlias(call.getString("name"), aliasClassNames());
            String refusal = setRefusal(Build.VERSION.SDK_INT, target);
            if (refusal != null) {
                call.resolve(new JSObject().put("ok", false).put("error", refusal));
                return;
            }
            preferences().edit().putString(PENDING_ALIAS_KEY, target).apply();
            call.resolve(new JSObject().put("ok", true));
        });
    }

    @Override
    protected void handleOnStop() {
        NativeFailureGuard.run("Unable to apply the Android app icon", this::applyPendingAlias);
    }

    /**
     * Whether the platform is offered the icon picker at all. The picker is
     * API 26 and newer while {@code minSdkVersion} is 24, so both methods give
     * the API 24 and 25 devices a build admits the same answer.
     */
    static boolean supportsAlternateIcons(int sdkInt) {
        return sdkInt >= Build.VERSION_CODES.O;
    }

    /**
     * Why {@code set} refuses to record an alias target, or null when it takes
     * it. The platform check comes first, so a caller that skipped
     * {@code supported} is refused rather than leaving a target behind that the
     * next background would toggle onto an API 24 or 25 launcher.
     */
    static String setRefusal(int sdkInt, String target) {
        if (!supportsAlternateIcons(sdkInt)) {
            return UNSUPPORTED_ERROR;
        }
        return target == null ? UNKNOWN_ICON_ERROR : null;
    }

    /**
     * The wire name an alias class name stands for, or null when the class is
     * not an alternate icon alias. Only the generated {@code avatar_eyes_}
     * aliases are alternates, so the primary alias and anything else sharing
     * the namespace read as null. The suffix is the wire name with every dash
     * replaced by an underscore, so the reverse is a whole-string swap.
     */
    static String wireNameForAlias(String aliasClassName) {
        if (
            aliasClassName == null ||
            !aliasClassName.startsWith(ALTERNATE_PREFIX) ||
            aliasClassName.length() == ALTERNATE_PREFIX.length()
        ) {
            return null;
        }
        return aliasClassName.substring(ALIAS_PREFIX.length()).replace('_', '-');
    }

    /**
     * The alias class name a wire name stands for, or null when the name cannot
     * name an alternate. The result is put back through
     * {@link #wireNameForAlias(String)}, so the two are exact inverses and the
     * primary alias stays unaddressable this way.
     */
    static String aliasForWireName(String wireName) {
        if (wireName == null || wireName.isEmpty()) {
            return null;
        }
        String alias = ALIAS_PREFIX + wireName.replace('-', '_');
        return wireNameForAlias(alias) == null ? null : alias;
    }

    /**
     * Whether a declared activity is a launcher alias this plugin owns, which
     * is the primary alias or one of the generated alternates. Every other
     * activity is invisible to the plugin, so an apply never toggles it.
     */
    static boolean isIconAlias(String activityName) {
        return PRIMARY_ALIAS.equals(activityName) || wireNameForAlias(activityName) != null;
    }

    /** Sorted wire names of the alternates present, primary excluded. */
    static List<String> wireNames(List<String> aliasClassNames) {
        List<String> names = new ArrayList<>();
        for (String aliasClassName : aliasClassNames) {
            String wireName = wireNameForAlias(aliasClassName);
            if (wireName != null) {
                names.add(wireName);
            }
        }
        Collections.sort(names);
        return names;
    }

    /**
     * The icon the home screen is heading for: a recorded target that has not
     * been applied yet wins over the alias currently enabled, and the primary
     * alias reads as null because it is the default icon, not an alternate.
     */
    static String currentWireName(String pendingAlias, String enabledAlias) {
        return wireNameForAlias(pendingAlias == null ? enabledAlias : pendingAlias);
    }

    /**
     * The alias {@link #set} should record for a requested name: the primary
     * alias for a null reset, the matching alternate when this build ships one,
     * or null when nothing installed can draw the name.
     */
    static String targetAlias(String name, List<String> aliasClassNames) {
        if (name == null) {
            return PRIMARY_ALIAS;
        }
        String alias = aliasForWireName(name);
        return alias != null && aliasClassNames.contains(alias) ? alias : null;
    }

    /**
     * Whether the primary alias has to go back to the manifest default, given
     * the enabled setting each alias this build declares reads back as: it does
     * when the build declares a primary alias and none of the declared aliases
     * is drawing the app, which is the state an applied alternate that the
     * build does not declare leaves behind.
     */
    static boolean restoresPrimaryAlias(Map<String, Integer> enabledSettings) {
        if (!enabledSettings.containsKey(PRIMARY_ALIAS)) {
            return false;
        }
        for (Map.Entry<String, Integer> entry : enabledSettings.entrySet()) {
            if (drawsLauncherIcon(entry.getKey(), entry.getValue())) {
                return false;
            }
        }
        return true;
    }

    /**
     * Whether an alias is drawing the app in the launcher. An explicit enable
     * always draws, and the manifest default draws only for the primary alias,
     * the one alias the manifest declares enabled.
     */
    private static boolean drawsLauncherIcon(String aliasClassName, int enabledSetting) {
        if (enabledSetting == PackageManager.COMPONENT_ENABLED_STATE_ENABLED) {
            return true;
        }
        return (
            enabledSetting == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT &&
            PRIMARY_ALIAS.equals(aliasClassName)
        );
    }

    static JSObject statePayload(boolean supported, String current, List<String> available) {
        JSObject payload = new JSObject();
        payload.put("supported", supported);
        payload.put("current", current == null ? JSObject.NULL : current);
        payload.put("available", new JSArray(available));
        return payload;
    }

    /**
     * Every icon alias this build declares, enabled or not, so the disabled
     * alternates the manifest ships are still discoverable. Activities that are
     * not icon aliases are skipped, which is what keeps them out of
     * {@code available} and out of the toggles an apply performs.
     */
    private List<String> aliasClassNames() {
        List<String> aliases = new ArrayList<>();
        Context context = getContext();
        PackageInfo info;
        try {
            info = context
                .getPackageManager()
                .getPackageInfo(
                    context.getPackageName(),
                    PackageManager.GET_ACTIVITIES | PackageManager.MATCH_DISABLED_COMPONENTS
                );
        } catch (PackageManager.NameNotFoundException exception) {
            NativeFailureGuard.record("Unable to read the Android app icon aliases", exception);
            return aliases;
        }
        if (info.activities == null) {
            return aliases;
        }
        for (ActivityInfo activity : info.activities) {
            if (isIconAlias(activity.name)) {
                aliases.add(activity.name);
            }
        }
        return aliases;
    }

    /** The one alternate alias explicitly enabled, or null when none is. */
    private String enabledAlternateAlias(List<String> aliasClassNames) {
        PackageManager packageManager = getContext().getPackageManager();
        for (String aliasClassName : aliasClassNames) {
            if (wireNameForAlias(aliasClassName) == null) {
                continue;
            }
            int setting = packageManager.getComponentEnabledSetting(component(aliasClassName));
            if (setting == PackageManager.COMPONENT_ENABLED_STATE_ENABLED) {
                return aliasClassName;
            }
        }
        return null;
    }

    /**
     * Apply whatever {@code set} last recorded, then hold the launcher to
     * exactly one enabled alias whether or not anything was recorded.
     */
    private void reconcileLauncherAliases() {
        applyPendingAlias();
        restoreLauncherIfOrphaned();
    }

    /**
     * Put the primary alias back on the launcher when no alias this build
     * declares is drawing the app, which is where an applied alternate that
     * this build does not declare leaves a device: the enabled-state overrides
     * survive the install, so the alternate is gone and the primary stays
     * explicitly disabled with nothing left to launch.
     */
    private void restoreLauncherIfOrphaned() {
        PackageManager packageManager = getContext().getPackageManager();
        Map<String, Integer> enabledSettings = new LinkedHashMap<>();
        for (String aliasClassName : aliasClassNames()) {
            enabledSettings.put(
                aliasClassName,
                packageManager.getComponentEnabledSetting(component(aliasClassName))
            );
        }
        if (restoresPrimaryAlias(enabledSettings)) {
            setEnabledState(
                packageManager,
                PRIMARY_ALIAS,
                PackageManager.COMPONENT_ENABLED_STATE_DEFAULT
            );
        }
    }

    /**
     * Put the recorded target on the home screen, if there is one. The target is
     * enabled before the others are disabled, so no launcher ever sees the app
     * with every launcher component off, and the record is cleared last so an
     * interrupted pass is retried rather than half kept.
     */
    private void applyPendingAlias() {
        String target = pendingAlias();
        if (target == null) {
            return;
        }
        List<String> aliases = aliasClassNames();
        if (aliases.contains(target)) {
            PackageManager packageManager = getContext().getPackageManager();
            setEnabledState(
                packageManager,
                target,
                PRIMARY_ALIAS.equals(target)
                    ? PackageManager.COMPONENT_ENABLED_STATE_DEFAULT
                    : PackageManager.COMPONENT_ENABLED_STATE_ENABLED
            );
            for (String aliasClassName : aliases) {
                if (!aliasClassName.equals(target)) {
                    setEnabledState(
                        packageManager,
                        aliasClassName,
                        PackageManager.COMPONENT_ENABLED_STATE_DISABLED
                    );
                }
            }
        }
        preferences().edit().remove(PENDING_ALIAS_KEY).apply();
    }

    private void setEnabledState(PackageManager packageManager, String aliasClassName, int state) {
        packageManager.setComponentEnabledSetting(
            component(aliasClassName),
            state,
            PackageManager.DONT_KILL_APP
        );
    }

    private ComponentName component(String aliasClassName) {
        return new ComponentName(getContext().getPackageName(), aliasClassName);
    }

    private String pendingAlias() {
        return preferences().getString(PENDING_ALIAS_KEY, null);
    }

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }
}
