package ai.vellum.assistant.push;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import androidx.annotation.Nullable;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.Comparator;
import java.util.Locale;
import java.util.function.Function;
import javax.net.ssl.HttpsURLConnection;

/**
 * Disk cache for the sender avatars drawn into conversation notifications.
 * Every method blocks on the calling thread, which is the Firebase message
 * thread rather than the main thread. {@link #load} is a disk read; only
 * {@link #fetch} touches the network.
 */
public final class AvatarCache {
    private static final String DIRECTORY = "notification-avatars";
    private static final String EXTENSION = ".png";
    private static final int MAX_BYTES = 512 * 1024;
    // The timeouts run inside onMessageReceived, whose window is far shorter
    // than the 8 s an iOS notification-service extension gets, and a cached
    // avatar is a handful of kilobytes, so a stalled host has to give up fast.
    private static final int CONNECT_TIMEOUT_MILLIS = 3_000;
    private static final int READ_TIMEOUT_MILLIS = 3_000;
    private static final int MAX_FILES = 8;
    // A notification large icon is displayed at well under 512 px, and a
    // decoded bitmap this size costs a megabyte of the Firebase callback's heap.
    private static final int MAX_PIXELS = 512;
    private static final int MAX_BITMAP_BYTES = 4 * 1024 * 1024;

    private final File directory;

    public AvatarCache(Context context) {
        directory = new File(context.getCacheDir(), DIRECTORY);
    }

    @Nullable
    public Bitmap load(@Nullable String hash) {
        String normalized = normalized(hash);
        if (normalized == null) {
            return null;
        }
        File file = new File(directory, normalized + EXTENSION);
        Bitmap bitmap = decode(options -> BitmapFactory.decodeFile(file.getPath(), options));
        if (bitmap != null) {
            // Eviction reads the modified time, so a hit is also a touch.
            file.setLastModified(System.currentTimeMillis());
        }
        return bitmap;
    }

    @Nullable
    public Bitmap fetch(@Nullable String url, @Nullable String hash) {
        String normalized = normalized(hash);
        if (normalized == null || url == null || url.isEmpty()) {
            return null;
        }
        byte[] bytes = download(url);
        if (bytes == null || !normalized.equals(sha256Hex(bytes))) {
            return null;
        }
        Bitmap bitmap = decode(options ->
            BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options)
        );
        if (bitmap == null) {
            return null;
        }
        store(normalized, bytes);
        return bitmap;
    }

    /**
     * Reads the bounds first so the image is downsampled as it is decoded: a
     * push claiming an enormous avatar must not allocate it in full.
     */
    @Nullable
    private static Bitmap decode(Function<BitmapFactory.Options, Bitmap> decoder) {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        decoder.apply(bounds);
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight);
        return bounded(decoder.apply(options));
    }

    /** Halvings that bring the longest edge down to {@link #MAX_PIXELS}. */
    static int sampleSize(int width, int height) {
        int longest = Math.max(width, height);
        int size = 1;
        while (longest / size > MAX_PIXELS) {
            size *= 2;
        }
        return size;
    }

    /** Downsampling alone still leaves room for an allocation the callback cannot afford. */
    @Nullable
    private static Bitmap bounded(@Nullable Bitmap bitmap) {
        if (bitmap == null) {
            return null;
        }
        if (bitmap.getByteCount() > MAX_BITMAP_BYTES) {
            bitmap.recycle();
            return null;
        }
        return bitmap;
    }

    private void store(String hash, byte[] bytes) {
        directory.mkdirs();
        File temporary = new File(directory, hash + EXTENSION + ".tmp");
        try (FileOutputStream output = new FileOutputStream(temporary)) {
            output.write(bytes);
        } catch (IOException exception) {
            temporary.delete();
            return;
        }
        if (!temporary.renameTo(new File(directory, hash + EXTENSION))) {
            temporary.delete();
            return;
        }
        prune();
    }

    /** Keeps the {@link #MAX_FILES} most recently used avatars. */
    private void prune() {
        File[] files = directory.listFiles((unused, name) -> name.endsWith(EXTENSION));
        if (files == null || files.length <= MAX_FILES) {
            return;
        }
        Arrays.sort(files, Comparator.comparingLong(File::lastModified).reversed());
        for (int index = MAX_FILES; index < files.length; index++) {
            files[index].delete();
        }
    }

    @Nullable
    private static byte[] download(String url) {
        HttpsURLConnection connection = null;
        try {
            URL parsed = new URL(url);
            if (!"https".equalsIgnoreCase(parsed.getProtocol())) {
                return null;
            }
            connection = (HttpsURLConnection) parsed.openConnection();
            connection.setConnectTimeout(CONNECT_TIMEOUT_MILLIS);
            connection.setReadTimeout(READ_TIMEOUT_MILLIS);
            if (connection.getResponseCode() != HttpsURLConnection.HTTP_OK) {
                return null;
            }
            try (InputStream stream = connection.getInputStream()) {
                return readCapped(stream);
            }
        } catch (IOException | RuntimeException exception) {
            return null;
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    @Nullable
    static byte[] readCapped(InputStream stream) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int read = stream.read(chunk);
        while (read != -1) {
            if (buffer.size() + read > MAX_BYTES) {
                return null;
            }
            buffer.write(chunk, 0, read);
            read = stream.read(chunk);
        }
        return buffer.toByteArray();
    }

    static String sha256Hex(byte[] bytes) {
        final byte[] digest;
        try {
            digest = MessageDigest.getInstance("SHA-256").digest(bytes);
        } catch (NoSuchAlgorithmException exception) {
            return "";
        }
        StringBuilder hex = new StringBuilder(digest.length * 2);
        for (byte value : digest) {
            hex.append(Character.forDigit((value >> 4) & 0xf, 16));
            hex.append(Character.forDigit(value & 0xf, 16));
        }
        return hex.toString();
    }

    /** Lowercased sha256 hex, which is also a filename that cannot escape the cache. */
    @Nullable
    static String normalized(@Nullable String hash) {
        if (hash == null || !hash.matches("[0-9a-fA-F]{64}")) {
            return null;
        }
        return hash.toLowerCase(Locale.ROOT);
    }
}
