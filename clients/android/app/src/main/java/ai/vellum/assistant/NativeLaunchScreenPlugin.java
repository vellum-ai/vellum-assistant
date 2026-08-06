package ai.vellum.assistant;

import android.app.Activity;
import android.app.UiModeManager;
import android.content.Context;
import android.content.res.Configuration;
import android.os.Build;
import androidx.appcompat.app.AppCompatDelegate;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NativeLaunchScreen")
public class NativeLaunchScreenPlugin extends Plugin {
    private static final int APPLICATION_NIGHT_MODE_UNSPECIFIED =
        Configuration.UI_MODE_NIGHT_UNDEFINED >> 4;
    private static final String FAILURE_CODE = "LAUNCH_SCREEN_FAILED";
    private static final String FAILURE_MESSAGE = "Android launch screen is unavailable";
    private static final String PREFERENCES = "vellum_launch_screen";
    private static final String THEME_KEY = "theme";

    @PluginMethod
    public void ready(PluginCall call) {
        NativeFailureGuard.call(call, FAILURE_MESSAGE, FAILURE_CODE, () -> {
            if (!storeTheme(call)) {
                return;
            }
            Activity activity = getActivity();
            if (!(activity instanceof MainActivity)) {
                call.reject(FAILURE_MESSAGE, FAILURE_CODE);
                return;
            }
            activity.runOnUiThread(() -> {
                NativeFailureGuard.call(call, FAILURE_MESSAGE, FAILURE_CODE, () -> {
                    ((MainActivity) activity).hideLaunchScreen();
                    call.resolve();
                });
            });
        });
    }

    @PluginMethod
    public void setTheme(PluginCall call) {
        NativeFailureGuard.call(call, FAILURE_MESSAGE, FAILURE_CODE, () -> {
            if (storeTheme(call)) {
                call.resolve();
            }
        });
    }

    static int backgroundColor(Context context) {
        return context.getColor(R.color.launch_screen_background);
    }

    static int foregroundColor(Context context) {
        return context.getColor(R.color.launch_screen_foreground);
    }

    static void applySavedTheme(Context context) {
        applyTheme(context, storedTheme(context));
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
        applyTheme(getContext(), theme);
        return true;
    }

    private static String storedTheme(Context context) {
        return context
            .getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
            .getString(THEME_KEY, "system");
    }

    private static void applyTheme(Context context, String theme) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            UiModeManager uiModeManager = context.getSystemService(UiModeManager.class);
            if (uiModeManager != null) {
                uiModeManager.setApplicationNightMode(platformNightMode(theme));
            }
            return;
        }
        AppCompatDelegate.setDefaultNightMode(appCompatNightMode(theme));
    }

    private static int platformNightMode(String theme) {
        if ("dark".equals(theme)) {
            return UiModeManager.MODE_NIGHT_YES;
        }
        if ("light".equals(theme)) {
            return UiModeManager.MODE_NIGHT_NO;
        }
        return APPLICATION_NIGHT_MODE_UNSPECIFIED;
    }

    private static int appCompatNightMode(String theme) {
        if ("dark".equals(theme)) {
            return AppCompatDelegate.MODE_NIGHT_YES;
        }
        if ("light".equals(theme)) {
            return AppCompatDelegate.MODE_NIGHT_NO;
        }
        return AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM;
    }

    private static boolean isTheme(String theme) {
        return "system".equals(theme) || "light".equals(theme) || "dark".equals(theme);
    }
}
