package io.github.aureliuswu.fundval;

import java.io.ByteArrayInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/** Run on the host JDK without an emulator or Android dependencies. */
public final class BoundedSelectionTest {
    private static int checks;

    public static void main(String[] args) throws IOException {
        byte[] json = "\ufeff \r\n{\"schema\":3,\"holdings\":[]}".getBytes(StandardCharsets.UTF_8);
        verify(json, false, json.length, true);
        verify(json, false, json.length - 1, false);
        verify(" []".getBytes(StandardCharsets.UTF_8), false, 3, true);
        verify("\r\n\t".getBytes(StandardCharsets.UTF_8), false, 4, false);
        verify("<html>".getBytes(StandardCharsets.UTF_8), false, 64, false);
        verify(new byte[]{(byte) 0xef, '{'}, false, 10, false);
        verify(new byte[0], false, 1, false);
        verify(new byte[]{(byte) 0x89, 'P', 'N', 'G', 13, 10, 26, 10}, true, 8, true);
        verify(new byte[]{(byte) 0xff, (byte) 0xd8, (byte) 0xff}, true, 10, true);
        verify(new byte[]{'R', 'I', 'F', 'F', 0, 0, 0, 0, 'W', 'E', 'B', 'P'}, true, 32, true);
        verify(new byte[]{'R', 'I', 'F', 'F', 0, 0, 0, 0, 'A', 'V', 'I', ' '}, true, 32, false);
        verify(new byte[]{(byte) 0x89, 'P', 'N', 'G', 13}, true, 32, false);
        try (ByteArrayInputStream cancelled = new ByteArrayInputStream(json)) {
            if (BoundedSelection.valid(cancelled, false, 64, () -> true) || cancelled.available() != json.length) {
                throw new AssertionError("Cancellation must not read selected data");
            }
            checks++;
        }
        System.out.println("BoundedSelection " + checks + " checks passed");
    }

    private static void verify(byte[] bytes, boolean image, int limit, boolean expected) throws IOException {
        // Simulate fragmented reads across BOM and image signature boundaries.
        try (FilterInputStream oneByte = new FilterInputStream(new ByteArrayInputStream(bytes)) {
            @Override public int read(byte[] buffer, int start, int count) throws IOException {
                return super.read(buffer, start, Math.min(count, 1));
            }
        }) {
            if (BoundedSelection.valid(oneByte, image, limit, () -> false) != expected) {
                throw new AssertionError("Unexpected preflight result at check " + checks);
            }
            checks++;
        }
    }
}
