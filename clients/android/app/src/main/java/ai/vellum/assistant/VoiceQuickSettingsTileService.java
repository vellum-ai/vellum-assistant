package ai.vellum.assistant;

import android.app.PendingIntent;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;
import androidx.core.service.quicksettings.PendingIntentActivityWrapper;
import androidx.core.service.quicksettings.TileServiceCompat;

public class VoiceQuickSettingsTileService extends TileService {
    @Override
    public void onStartListening() {
        super.onStartListening();
        Tile tile = getQsTile();
        if (tile != null) {
            tile.setState(Tile.STATE_INACTIVE);
            tile.setLabel(getString(R.string.voice_tile_label));
            tile.updateTile();
        }
    }

    @Override
    public void onClick() {
        super.onClick();
        if (isLocked()) {
            unlockAndRun(this::launchVoice);
            return;
        }
        launchVoice();
    }

    private void launchVoice() {
        TileServiceCompat.startActivityAndCollapse(
            this,
            new PendingIntentActivityWrapper(
                this,
                0,
                VoiceDeepLink.startVoiceIntent(this),
                PendingIntent.FLAG_UPDATE_CURRENT,
                false
            )
        );
    }
}
