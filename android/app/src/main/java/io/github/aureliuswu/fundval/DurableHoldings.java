package io.github.aureliuswu.fundval;

import android.content.Context;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.util.AtomicFile;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/** Private, generation-checked repository checkpoint; never stores credentials or OCR input. */
final class DurableHoldings {
    static final int MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
    private static final Object LOCK = new Object();
    private static final String V3 = "fuyu_holdings_v3";
    private static final String JOURNAL = "fuyu_holdings_repository_journal_v1";
    private static final String[] KEYS = {
            V3, "fuyu_holdings_v1", "fuyu_device_id_v1",
            "fuyu_holdings_repository_backup_latest_v1", "fuyu_holdings_repository_backup_previous_v1",
            JOURNAL, "fuyu_holdings_projection_meta_v1", "fuyu_backup_latest", "fuyu_backup_previous"
    };
    private final File directory;
    private final AtomicFile file;

    DurableHoldings(Context context) {
        directory = context.getNoBackupFilesDir();
        file = new AtomicFile(new File(directory, "fundval-holdings-checkpoint-v1.json"));
    }

    JSONObject handle(JSONObject request) {
        synchronized (LOCK) {
            try {
                String op = request.optString("op");
                if (!op.equals("read") && !op.equals("commit")) return error("android_storage_protocol");
                JSONObject current = readRecord();
                int generation = current == null ? 0 : current.getInt("generation");
                if (op.equals("read")) {
                    return new JSONObject().put("ok", true).put("generation", generation)
                            .put("snapshot", current == null ? JSONObject.NULL : current.getJSONObject("snapshot"));
                }
                if (boundedGeneration(request.opt("generation")) != generation || generation == Integer.MAX_VALUE) {
                    return error("android_checkpoint_stale");
                }
                JSONObject next = request.optJSONObject("snapshot");
                if (!validSnapshot(next)) return error("android_checkpoint_invalid");
                JSONObject record = new JSONObject().put("format", 1).put("generation", generation + 1)
                        .put("snapshot", next);
                byte[] bytes = record.toString().getBytes(StandardCharsets.UTF_8);
                if (bytes.length > MAX_SNAPSHOT_BYTES + 1024) return error("android_checkpoint_invalid");
                writeRecord(bytes);
                if (!Arrays.equals(bytes, readBytes())) return error("android_checkpoint_write_failed");
                return new JSONObject().put("ok", true).put("generation", generation + 1);
            } catch (IOException | ErrnoException | JSONException | SecurityException error) {
                return error("android_storage_unavailable");
            }
        }
    }

    private JSONObject readRecord() throws IOException, JSONException {
        File base = file.getBaseFile();
        // A pending .new without a base was never committed. A legacy .bak
        // is intentionally handed to AtomicFile's own recovery logic.
        if (!base.exists() && !new File(base.getPath() + ".bak").exists()) {
            if (!directory.isDirectory()) throw new IOException("Checkpoint directory unavailable");
            return null;
        }
        JSONObject record = new JSONObject(new String(readBytes(), StandardCharsets.UTF_8));
        if (record.length() != 3 || boundedGeneration(record.opt("format")) != 1
                || boundedGeneration(record.opt("generation")) <= 0 || !validSnapshot(record.optJSONObject("snapshot"))) {
            throw new IOException("Checkpoint shape invalid");
        }
        return record;
    }

    private byte[] readBytes() throws IOException {
        try (FileInputStream stream = file.openRead(); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            for (int size; (size = stream.read(buffer)) != -1;) {
                if (bytes.size() + size > MAX_SNAPSHOT_BYTES + 1024) throw new IOException("Checkpoint too large");
                bytes.write(buffer, 0, size);
            }
            return bytes.toByteArray();
        }
    }

    private void writeRecord(byte[] bytes) throws IOException, ErrnoException {
        FileOutputStream stream = file.startWrite();
        try {
            stream.write(bytes);
            stream.getFD().sync();
            file.finishWrite(stream);
        } catch (IOException | RuntimeException failure) {
            file.failWrite(stream);
            throw failure;
        }
        // Make the rename durable before acknowledging (including OS reboot).
        FileDescriptor fd = Os.open(directory.getPath(), OsConstants.O_RDONLY, 0);
        try { Os.fsync(fd); } finally { Os.close(fd); }
    }

    private static int boundedGeneration(Object value) {
        if (!(value instanceof Number)) return -1;
        double number = ((Number) value).doubleValue();
        return number >= 0 && number <= Integer.MAX_VALUE && number == Math.floor(number) ? (int) number : -1;
    }

    private static boolean validSnapshot(JSONObject snapshot) throws JSONException {
        if (snapshot == null || snapshot.length() != KEYS.length || !snapshot.isNull(JOURNAL)) return false;
        for (String key : KEYS) {
            Object value = snapshot.opt(key);
            if (value != JSONObject.NULL && !(value instanceof String)) return false;
        }
        if (!(snapshot.opt(V3) instanceof String) || !(snapshot.opt("fuyu_holdings_v1") instanceof String)
                || !(snapshot.opt("fuyu_device_id_v1") instanceof String)
                || snapshot.toString().getBytes(StandardCharsets.UTF_8).length > MAX_SNAPSHOT_BYTES) return false;
        JSONObject document = new JSONObject(snapshot.getString(V3));
        return boundedGeneration(document.opt("schema")) == 3 && document.opt("holdings") instanceof JSONArray;
    }

    private static JSONObject error(String reason) {
        try { return new JSONObject().put("ok", false).put("reason", reason); }
        catch (JSONException impossible) { throw new IllegalStateException(impossible); }
    }
}
