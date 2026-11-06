package io.github.aureliuswu.fundval;

import java.io.IOException;
import java.io.InputStream;
import java.util.function.BooleanSupplier;

/** Bounded preflight for SAF streams. The app's original parsers still validate content. */
final class BoundedSelection {
    private BoundedSelection() {}

    static boolean valid(InputStream stream, boolean image, int limit, BooleanSupplier cancelled)
            throws IOException {
        if (limit < 1 || cancelled.getAsBoolean()) return false;
        byte[] buffer = new byte[Math.min(limit, 16384)];
        byte[] signature = image ? new byte[12] : null;
        int total = 0;
        int bom = 0;
        boolean jsonStarted = false;
        while (total < limit) {
            if (cancelled.getAsBoolean()) return false;
            int count = stream.read(buffer, 0, Math.min(buffer.length, limit - total));
            if (count < 0) break;
            if (count == 0) return false;
            if (image && total < signature.length) {
                System.arraycopy(buffer, 0, signature, total, Math.min(count, signature.length - total));
            } else if (!image && !jsonStarted) {
                for (int i = 0; i < count; i++) {
                    int value = buffer[i] & 255;
                    if (total == 0 && i == 0 && value == 0xef) { bom = 1; continue; }
                    if (bom == 1) {
                        if (value != 0xbb) return false;
                        bom = 2;
                        continue;
                    }
                    if (bom == 2) {
                        if (value != 0xbf) return false;
                        bom = 3;
                        continue;
                    }
                    if (value == ' ' || value == '\t' || value == '\n' || value == '\r') continue;
                    if (value != '{' && value != '[') return false;
                    jsonStarted = true;
                    break;
                }
            }
            total += count;
        }
        if (cancelled.getAsBoolean() || (total == limit && stream.read() != -1)) return false;
        if (!image) return jsonStarted;
        return (total >= 8 && (signature[0] & 255) == 0x89
                && signature[1] == 'P' && signature[2] == 'N' && signature[3] == 'G'
                && signature[4] == 13 && signature[5] == 10 && signature[6] == 26 && signature[7] == 10)
                || (total >= 3 && (signature[0] & 255) == 0xff && (signature[1] & 255) == 0xd8
                && (signature[2] & 255) == 0xff)
                || (total >= 12 && signature[0] == 'R' && signature[1] == 'I' && signature[2] == 'F'
                && signature[3] == 'F' && signature[8] == 'W' && signature[9] == 'E'
                && signature[10] == 'B' && signature[11] == 'P');
    }
}
