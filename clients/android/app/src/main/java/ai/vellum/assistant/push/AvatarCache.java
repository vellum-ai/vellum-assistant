package ai.vellum.assistant.push;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Base64;
import androidx.annotation.Nullable;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
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
    private static final String TEMPORARY_EXTENSION = ".tmp";
    static final int MAX_BYTES = 512 * 1024;
    static final int MAX_BASE64_CHARACTERS = ((MAX_BYTES + 2) / 3) * 4;
    // The timeouts run inside onMessageReceived, whose window is far shorter
    // than the 8 s an iOS notification-service extension gets, and a cached
    // avatar is a handful of kilobytes, so a stalled host has to give up fast.
    private static final int CONNECT_TIMEOUT_MILLIS = 3_000;
    // Bounds the response head and each body read alike.
    private static final int READ_TIMEOUT_MILLIS = 2_000;
    // The read timeout restarts on every chunk, so the response head and the
    // body share one total deadline, started before the head is read: a host
    // trickling bytes must not cost the whole notification. A head that
    // arrives slowly spends the body's share rather than adding to it, and one
    // that spends all of it gives up before a byte of body is read. The
    // deadline is only read between chunks, and Android fixes the socket
    // timeout when the connection is made, so the read that crosses it still
    // runs its full timeout out: a connect, the budget, and that last read
    // bound a responding host at 8 s.
    private static final long RESPONSE_BUDGET_MILLIS = 3_000;
    // A local file has no host trickling it, so its read carries no deadline.
    private static final long NO_DEADLINE = 0;
    private static final int MAX_FILES = 8;
    // A write that never finished belongs to a call that is long gone.
    private static final long TEMPORARY_MAX_AGE_MILLIS = 60_000;
    // A notification large icon is displayed at well under 512 px, and a
    // decoded bitmap this size costs a megabyte of the Firebase callback's heap.
    static final int MAX_PIXELS = 512;

    private final File directory;

    public AvatarCache(Context context) {
        this(new File(context.getCacheDir(), DIRECTORY));
    }

    AvatarCache(File directory) {
        this.directory = directory;
    }

    @Nullable
    public Bitmap load(@Nullable String hash) {
        byte[] bytes = verified(hash);
        if (bytes == null) {
            return null;
        }
        return decode(options -> BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options));
    }

    @Nullable
    public Bitmap fetch(@Nullable String url, @Nullable String hash) {
        String name = validated(hash);
        if (name == null || url == null || url.isEmpty()) {
            return null;
        }
        byte[] bytes = download(url);
        if (bytes == null || !name.equals(sha256Hex(bytes))) {
            return null;
        }
        Bitmap bitmap = decode(options ->
            BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options)
        );
        if (bitmap == null) {
            return null;
        }
        store(name, bytes);
        return bitmap;
    }

    /**
     * Validates and decodes a bridge-provided PNG without permitting its
     * metadata to allocate an oversized bitmap. A valid image also warms the
     * same content-addressed cache used by remote pushes.
     */
    @Nullable
    public Bitmap decodeInline(@Nullable String base64, @Nullable String hash) {
        byte[] bytes = validatedInlineBytes(
            base64,
            hash,
            value -> Base64.decode(value, Base64.DEFAULT)
        );
        if (bytes == null) {
            return null;
        }
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
        if (!supportedInlineBounds(bounds.outWidth, bounds.outHeight, bounds.outMimeType)) {
            return null;
        }
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight);
        Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
        if (
            bitmap == null
                || bitmap.getWidth() <= 0
                || bitmap.getHeight() <= 0
                || bitmap.getWidth() > MAX_PIXELS
                || bitmap.getHeight() > MAX_PIXELS
        ) {
            return null;
        }
        store(hash, bytes);
        return bitmap;
    }

    @FunctionalInterface
    interface Base64Decoder {
        byte[] decode(String value);
    }

    /** Byte-level validation that runs before Android is allowed to inspect pixels. */
    @Nullable
    static byte[] validatedInlineBytes(
        @Nullable String base64,
        @Nullable String expectedHash,
        Base64Decoder decoder
    ) {
        if (
            base64 == null
                || base64.length() < 4
                || base64.length() > MAX_BASE64_CHARACTERS
                || !isCanonicalBase64(base64)
                || validated(expectedHash) == null
        ) {
            return null;
        }
        final byte[] bytes;
        try {
            bytes = decoder.decode(base64);
        } catch (IllegalArgumentException exception) {
            return null;
        }
        if (
            bytes == null
                || bytes.length == 0
                || bytes.length > MAX_BYTES
                || !hasPngSignature(bytes)
                || !expectedHash.equals(sha256Hex(bytes))
        ) {
            return null;
        }
        return bytes;
    }

    static boolean supportedInlineBounds(int width, int height, @Nullable String mimeType) {
        return width > 0
            && height > 0
            && width <= MAX_PIXELS
            && height <= MAX_PIXELS
            && "image/png".equals(mimeType);
    }

    private static boolean hasPngSignature(byte[] bytes) {
        return bytes.length >= 8
            && (bytes[0] & 0xff) == 0x89
            && bytes[1] == 0x50
            && bytes[2] == 0x4e
            && bytes[3] == 0x47
            && bytes[4] == 0x0d
            && bytes[5] == 0x0a
            && bytes[6] == 0x1a
            && bytes[7] == 0x0a;
    }

    private static boolean isCanonicalBase64(String value) {
        if (value.length() % 4 != 0) {
            return false;
        }
        int paddingStart = value.length();
        if (value.endsWith("==")) {
            paddingStart -= 2;
        } else if (value.endsWith("=")) {
            paddingStart -= 1;
        }
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            boolean alphabet = character >= 'A' && character <= 'Z'
                || character >= 'a' && character <= 'z'
                || character >= '0' && character <= '9'
                || character == '+'
                || character == '/';
            if (index < paddingStart) {
                if (!alphabet) {
                    return false;
                }
            } else if (character != '=') {
                return false;
            }
        }
        return paddingStart > 0;
    }

    /**
     * Cached bytes whose digest still matches the name they are filed under, so
     * an oversized, truncated, or tampered file is deleted rather than drawn. A
     * hit is also an eviction touch.
     */
    @Nullable
    byte[] verified(@Nullable String hash) {
        String name = validated(hash);
        if (name == null) {
            return null;
        }
        File file = new File(directory, name + EXTENSION);
        if (file.length() > MAX_BYTES) {
            // Too big to have been one of ours. Left in place it would sit in
            // the eviction list forever, re-read and refused on every push.
            file.delete();
            return null;
        }
        byte[] bytes = read(file);
        if (bytes == null) {
            return null;
        }
        if (!name.equals(sha256Hex(bytes))) {
            file.delete();
            return null;
        }
        file.setLastModified(System.currentTimeMillis());
        return bytes;
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
        return decoder.apply(options);
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

    private void store(String name, byte[] bytes) {
        directory.mkdirs();
        // A unique staging name so two callers writing one hash cannot truncate
        // each other's file mid-write.
        File temporary = new File(
            directory,
            name + "." + System.nanoTime() + TEMPORARY_EXTENSION
        );
        try (FileOutputStream output = new FileOutputStream(temporary)) {
            output.write(bytes);
        } catch (IOException exception) {
            temporary.delete();
            return;
        }
        if (!temporary.renameTo(new File(directory, name + EXTENSION))) {
            temporary.delete();
            return;
        }
        prune();
    }

    /**
     * Keeps the {@link #MAX_FILES} most recently used avatars and sweeps the
     * staging files left behind by a write that never reached its rename.
     */
    void prune() {
        File[] files = directory.listFiles();
        if (files == null) {
            return;
        }
        long abandonedBefore = System.currentTimeMillis() - TEMPORARY_MAX_AGE_MILLIS;
        List<File> cached = new ArrayList<>();
        for (File file : files) {
            String name = file.getName();
            if (name.endsWith(EXTENSION)) {
                cached.add(file);
            } else if (
                name.endsWith(TEMPORARY_EXTENSION) && file.lastModified() < abandonedBefore
            ) {
                file.delete();
            }
        }
        if (cached.size() <= MAX_FILES) {
            return;
        }
        cached.sort(Comparator.comparingLong(File::lastModified).reversed());
        for (File file : cached.subList(MAX_FILES, cached.size())) {
            file.delete();
        }
    }

    @Nullable
    private static byte[] read(File file) {
        try (FileInputStream input = new FileInputStream(file)) {
            return readCapped(input, NO_DEADLINE);
        } catch (IOException exception) {
            return null;
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
            long deadline = System.nanoTime() + RESPONSE_BUDGET_MILLIS * 1_000_000L;
            if (connection.getResponseCode() != HttpsURLConnection.HTTP_OK) {
                return null;
            }
            long remainingMillis = (deadline - System.nanoTime()) / 1_000_000L;
            if (remainingMillis <= 0) {
                return null;
            }
            try (InputStream stream = connection.getInputStream()) {
                return readCapped(stream, remainingMillis);
            }
        } catch (IOException | RuntimeException exception) {
            return null;
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    /**
     * Bytes up to {@link #MAX_BYTES}, or null once the payload passes the cap
     * or the budget runs out. The budget is what the caller has left of
     * {@link #RESPONSE_BUDGET_MILLIS}, not a fresh one. A budget of
     * {@link #NO_DEADLINE} reads to the end of the stream. Package-private so a
     * test can burn a budget quickly.
     */
    @Nullable
    static byte[] readCapped(InputStream stream, long budgetMillis) throws IOException {
        boolean deadlined = budgetMillis > NO_DEADLINE;
        long deadline = System.nanoTime() + budgetMillis * 1_000_000L;
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int read = stream.read(chunk);
        while (read != -1) {
            if (
                buffer.size() + read > MAX_BYTES
                    || (deadlined && System.nanoTime() - deadline >= 0)
            ) {
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

    /**
     * Lowercase sha256 hex, which is also a filename that cannot escape the
     * cache. Uppercase is rejected rather than folded so one avatar has one
     * name here, on iOS, and on the desktop.
     */
    @Nullable
    static String validated(@Nullable String hash) {
        return hash != null && hash.matches("[0-9a-f]{64}") ? hash : null;
    }
}
