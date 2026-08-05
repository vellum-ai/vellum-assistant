package ai.vellum.assistant;

import android.content.Context;
import android.content.res.Configuration;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.PluginMethod;

@CapacitorPlugin(name = "NativeLaunchScreen")
public class NativeLaunchScreenPlugin extends Plugin {
    private static final String PREFERENCES = "vellum_launch_screen";
    private static final String THEME_KEY = "theme";

    @PluginMethod
    public void ready(PluginCall call) {
        if (!storeTheme(call)) {
            return;
        }
        getActivity().runOnUiThread(() -> {
            MainActivity activity = (MainActivity) getActivity();
            activity.hideLaunchScreen();
            call.resolve();
        });
    }

    @PluginMethod
    public void setTheme(PluginCall call) {
        if (storeTheme(call)) {
            call.resolve();
        }
    }

    static int backgroundColor(Context context) {
        return context.getColor(
            isDark(context)
                ? R.color.launch_screen_background_dark
                : R.color.launch_screen_background_light
        );
    }

    static int foregroundColor(Context context) {
        return context.getColor(
            isDark(context)
                ? R.color.launch_screen_foreground_dark
                : R.color.launch_screen_foreground_light
        );
    }

    private boolean storeTheme(PluginCall call) {
        String theme = call.getString("theme");
        if (!isTheme(theme)) {
            call.reject("theme must be system, light, or dark");
            return false;
        }
        getContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
            .edit()
            .putString(THEME_KEY, theme)
            .apply();
        return true;
    }

    private static boolean isDark(Context context) {
        String theme = context
            .getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
            .getString(THEME_KEY, "system");
        if ("dark".equals(theme)) {
            return true;
        }
        if ("light".equals(theme)) {
            return false;
        }
        int nightMode = context.getResources().getConfiguration().uiMode
            & Configuration.UI_MODE_NIGHT_MASK;
        return nightMode == Configuration.UI_MODE_NIGHT_YES;
    }

    private static boolean isTheme(String theme) {
        return "system".equals(theme) || "light".equals(theme) || "dark".equals(theme);
    }
}
