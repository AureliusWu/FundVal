package io.github.aureliuswu.fundval;

import android.content.res.AssetManager;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

final class BundledSite {
    static final String HOST = "aureliuswu.github.io";
    static final String ORIGIN = "https://" + HOST;
    static final String SCOPE = "/FundVal/";
    static final String HOME = ORIGIN + SCOPE;
    private static final Pattern ASSET_PATH = Pattern.compile(
            "[A-Za-z0-9][A-Za-z0-9_.-]*(?:/[A-Za-z0-9][A-Za-z0-9_.-]*)*");
    private static final byte[] EMPTY = new byte[0];
    private static final Map<String, String> HEADERS;

    static {
        Map<String, String> headers = new HashMap<>();
        // These bytes belong to this APK, not a network cache or the PWA SW.
        headers.put("Cache-Control", "no-store");
        headers.put("X-Content-Type-Options", "nosniff");
        HEADERS = Collections.unmodifiableMap(headers);
    }

    private final AssetManager assets;

    BundledSite(AssetManager assets) {
        this.assets = assets;
    }

    static boolean isHttpsHost(Uri uri, String host) {
        if (uri == null || !"https".equals(uri.getScheme())) return false;
        String authority = uri.getEncodedAuthority();
        return host.equals(authority) || (host + ":443").equals(authority);
    }

    static boolean isHome(Uri uri) {
        return isHttpsHost(uri, HOST)
                && (SCOPE.equals(uri.getEncodedPath()) || (SCOPE + "index.html").equals(uri.getEncodedPath()));
    }

    static boolean isOcr(Uri uri) {
        return isHttpsHost(uri, HOST) && (SCOPE + "ocr-import.html").equals(uri.getEncodedPath());
    }

    static boolean isQuoteFrame(Uri uri) {
        return isHttpsHost(uri, HOST) && (SCOPE + "quote-bridge.html").equals(uri.getEncodedPath());
    }

    private static boolean permittedRemote(Uri uri) {
        // CSP still controls which page/opaque frame can use each endpoint.
        return isHttpsHost(uri, "sinan-estimate-push.ligugu69.workers.dev")
                || isHttpsHost(uri, "api.github.com")
                || isHttpsHost(uri, "push2.eastmoney.com")
                || isHttpsHost(uri, "fund.eastmoney.com")
                || isHttpsHost(uri, "qt.gtimg.cn");
    }

    WebResourceResponse intercept(WebResourceRequest request) {
        Uri uri = request.getUrl();
        if (request.isForMainFrame() && !isHome(uri) && !isOcr(uri)) {
            return error(403, "Forbidden");
        }
        if (!isHttpsHost(uri, HOST)) {
            String scheme = uri.getScheme();
            if (permittedRemote(uri) || "blob".equals(scheme) || "data".equals(scheme)
                    || "about".equals(scheme)) return null;
            return error(403, "Forbidden");
        }

        String method = request.getMethod();
        if (!"GET".equals(method) && !"HEAD".equals(method)) return error(405, "Method Not Allowed");
        String path = uri.getEncodedPath();
        if (path == null || !path.startsWith(SCOPE) || path.length() > 512) return error(404, "Not Found");
        String relative = path.substring(SCOPE.length());
        if (relative.isEmpty()) relative = "index.html";
        if (!ASSET_PATH.matcher(relative).matches()) return error(404, "Not Found");
        // No Android SW registration/update channel: the APK is the versioned
        // delivery boundary. Do not expose the packaged Web/PWA SW even if asked.
        if ("sw.js".equals(relative)) return error(404, "Not Found");
        try {
            InputStream stream = assets.open("www/" + relative, AssetManager.ACCESS_STREAMING);
            if ("HEAD".equals(method)) {
                stream.close();
                stream = new ByteArrayInputStream(EMPTY);
            }
            String mime = mimeType(relative);
            String encoding = mime.startsWith("text/") || mime.equals("application/javascript")
                    || mime.equals("application/json") ? "UTF-8" : null;
            return new WebResourceResponse(mime, encoding, 200, "OK", HEADERS, stream);
        } catch (IOException ignored) {
            // Missing packaged files must never resolve to a live Pages build.
            return error(404, "Not Found");
        }
    }

    private static WebResourceResponse error(int status, String reason) {
        return new WebResourceResponse("text/plain", "UTF-8", status, reason, HEADERS,
                new ByteArrayInputStream(reason.getBytes(StandardCharsets.UTF_8)));
    }

    private static String mimeType(String path) {
        String lower = path.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".html")) return "text/html";
        if (lower.endsWith(".css")) return "text/css";
        if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "application/javascript";
        if (lower.endsWith(".json")) return "application/json";
        if (lower.endsWith(".wasm")) return "application/wasm";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".gz")) return "application/gzip";
        if (lower.endsWith(".txt") || lower.endsWith(".md")) return "text/plain";
        return "application/octet-stream";
    }
}
