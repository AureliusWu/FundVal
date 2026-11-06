package io.github.aureliuswu.fundval;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.res.AssetFileDescriptor;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.util.JsonReader;
import android.util.JsonToken;
import android.util.Log;
import android.view.Gravity;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.CookieManager;
import android.webkit.JsResult;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebMessage;
import android.webkit.WebMessagePort;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.Toast;

import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final int PICK_IMPORT = 1;
    private static final int PICK_EXPORT = 2;
    private static final int MAX_BACKUP_BYTES = 4 * 1024 * 1024;
    private static final int MAX_IMAGE_BYTES = 16 * 1024 * 1024;
    private static final int MAX_BRIDGE_CHARS = 2 * MAX_BACKUP_BYTES + 1024;
    private static final long MAX_REQUEST_ID = 9007199254740991L;
    private static final int BRIDGE_RETRIES = 80;
    private static final String BRIDGE_PROTOCOL = "fundval-android-v2:";
    private static final String BACKUP_NAME = "fuyu-holdings.json";
    private static final String SAF_LOG = "FundValSAF";
    private static final String[] IMAGE_TYPES = { "image/png", "image/jpeg", "image/webp" };
    private static final String[] BACKUP_TYPES = { "application/json", "text/plain", "application/octet-stream", "text/json", "text/x-json" };

    private final ExecutorService fileWriter = Executors.newSingleThreadExecutor();
    private final ExecutorService storage = Executors.newSingleThreadExecutor();
    private FrameLayout root;
    private WebView web;
    private BundledSite site;
    private DurableHoldings durableHoldings;
    private ValueCallback<Uri[]> importResult;
    private CancellationSignal importRead;
    private boolean importImages;
    private WebMessagePort bridgePort;
    private long documentGeneration;
    private boolean bindingBridge;
    private PendingExport pendingExport;
    private int activePicker;
    private boolean writingExport;

    private static final class PendingExport {
        final WebMessagePort sender;
        final long id;
        final byte[] bytes;

        PendingExport(WebMessagePort sender, long id, byte[] bytes) {
            this.sender = sender;
            this.id = id;
            this.bytes = bytes;
        }
    }

    private static final class BundledWorkerClient extends ServiceWorkerClient {
        private final BundledSite site;

        BundledWorkerClient(BundledSite site) {
            this.site = site;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
            return site.intercept(request);
        }
    }

    @Override
    public void onCreate(Bundle savedState) {
        super.onCreate(savedState);
        if (savedState != null) Log.i(SAF_LOG, "activity restored");
        site = new BundledSite(getApplicationContext().getAssets());
        durableHoldings = new DurableHoldings(getApplicationContext());
        root = new FrameLayout(this);
        root.setBackgroundColor(getColor(R.color.app_background));
        setContentView(root);
        applyWindowInsets();

        // Only the separate test manifest may enable DevTools.
        WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);
        ServiceWorkerController workers = ServiceWorkerController.getInstance();
        workers.getServiceWorkerWebSettings().setAllowFileAccess(false);
        workers.getServiceWorkerWebSettings().setAllowContentAccess(false);
        workers.setServiceWorkerClient(new BundledWorkerClient(site));
        createWebView();
    }

    @SuppressWarnings("deprecation")
    private void applyWindowInsets() {
        if (Build.VERSION.SDK_INT < 30) return; // Legacy decor fit + adjustResize.
        getWindow().setDecorFitsSystemWindows(false);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarContrastEnforced(false);
        WindowInsetsController controller = getWindow().getInsetsController();
        if (controller != null) {
            int lightBars = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                    | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            controller.setSystemBarsAppearance(lightBars, lightBars);
        }
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            Insets safe = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            Insets keyboard = insets.getInsets(WindowInsets.Type.ime());
            view.setPadding(safe.left, safe.top, safe.right, Math.max(safe.bottom, keyboard.bottom));
            return WindowInsets.CONSUMED;
        });
        root.requestApplyInsets();
    }

    @SuppressWarnings("deprecation")
    private void createWebView() {
        root.removeAllViews();
        WebView view = new WebView(this);
        web = view;
        view.setBackgroundColor(getColor(R.color.app_background));
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setGeolocationEnabled(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false);

        view.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView caller, WebResourceRequest request) {
                return site.intercept(request);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView caller, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (!request.isForMainFrame()) return !BundledSite.isQuoteFrame(uri);
                if (BundledSite.isHome(uri) || BundledSite.isOcr(uri)) return false;
                // This is the sole external link in the app. Never navigate the
                // data-bearing WebView to it or honor arbitrary intent URLs.
                if (request.hasGesture() && BundledSite.isHttpsHost(uri, "github.com")
                        && "/settings/tokens".equals(uri.getEncodedPath())
                        && uri.getEncodedQuery() == null && uri.getEncodedFragment() == null) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE));
                    } catch (ActivityNotFoundException | SecurityException ignored) {
                        toast("未找到可用的浏览器");
                    }
                }
                return true;
            }

            @Override
            public void onPageStarted(WebView caller, String url, android.graphics.Bitmap favicon) {
                if (caller != web) return;
                logPickerInterruption("navigation");
                closeBridge();
                finishImport(null);
            }

            @Override
            public void onPageCommitVisible(WebView caller, String url) {
                startBridge(caller, asUri(url));
            }

            @Override
            public void onPageFinished(WebView caller, String url) {
                startBridge(caller, asUri(url));
            }

            @Override
            public boolean onRenderProcessGone(WebView caller, RenderProcessGoneDetail detail) {
                logPickerInterruption("renderer_gone");
                closeBridge();
                finishImport(null);
                if (caller == web) web = null;
                root.removeView(caller);
                caller.destroy();
                Button retry = new Button(MainActivity.this);
                retry.setText("页面已停止，点击重新打开");
                retry.setOnClickListener(button -> createWebView());
                root.addView(retry, new FrameLayout.LayoutParams(
                        FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER));
                return true;
            }
        });

        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                request.deny();
            }

            @Override
            public boolean onShowFileChooser(WebView caller, ValueCallback<Uri[]> callback,
                    FileChooserParams params) {
                openImport(caller, callback, params);
                return true;
            }

            @Override
            public boolean onJsBeforeUnload(WebView caller, String url, String message, JsResult result) {
                if (caller != web || (!BundledSite.isHome(asUri(url)) && !BundledSite.isOcr(asUri(url)))) {
                    result.cancel();
                    return true;
                }
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage("当前操作尚未完成。离开可能丢失未保存的内容。")
                        .setNegativeButton("继续编辑", (dialog, which) -> result.cancel())
                        .setPositiveButton("离开", (dialog, which) -> result.confirm())
                        .setOnCancelListener(dialog -> result.cancel())
                        .show();
                return true;
            }
        });

        root.addView(view, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        view.loadUrl(BundledSite.HOME);
    }

    private void openImport(WebView caller, ValueCallback<Uri[]> callback,
            WebChromeClient.FileChooserParams params) {
        Uri page = asUri(caller.getUrl());
        boolean images = BundledSite.isOcr(page);
        if (caller != web || activePicker != 0 || writingExport || importRead != null
                || (!images && !BundledSite.isHome(page))
                || params.getMode() != WebChromeClient.FileChooserParams.MODE_OPEN
                || params.isCaptureEnabled() || !allowedAcceptTypes(params.getAcceptTypes(), images)) {
            callback.onReceiveValue(null);
            return;
        }
        Intent picker = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                .setType(images ? "image/*" : "*/*")
                .putExtra(Intent.EXTRA_MIME_TYPES, images ? IMAGE_TYPES : BACKUP_TYPES);
        importResult = callback;
        importImages = images;
        activePicker = PICK_IMPORT;
        try {
            startActivityForResult(picker, PICK_IMPORT);
            safLog(PICK_IMPORT, "launched");
        } catch (ActivityNotFoundException | SecurityException ignored) {
            safLog(PICK_IMPORT, "launch_failed");
            activePicker = 0;
            finishImport(null);
            toast("无法打开系统文件选择器");
        }
    }

    private static boolean allowedAcceptTypes(String[] accepts, boolean images) {
        if (accepts == null) return false;
        boolean accepted = false;
        for (String entry : accepts) {
            if (entry == null) continue;
            for (String raw : entry.split(",")) {
                String type = raw.trim().toLowerCase(Locale.ROOT);
                if (type.isEmpty()) continue;
                boolean allowed = images
                        ? type.equals("image/png") || type.equals("image/jpeg") || type.equals("image/webp")
                        : type.equals(".json") || type.equals("application/json");
                if (!allowed) return false;
                accepted = true;
            }
        }
        return accepted;
    }

    private void finishImport(Uri uri) {
        ValueCallback<Uri[]> callback = importResult;
        importResult = null;
        CancellationSignal read = importRead;
        importRead = null;
        if (read != null) read.cancel();
        if (callback != null) callback.onReceiveValue(uri == null ? null : new Uri[] { uri });
    }

    private static boolean isTrustedPage(Uri uri) {
        return BundledSite.isHome(uri) || BundledSite.isOcr(uri);
    }

    private void startBridge(WebView caller, Uri committed) {
        Uri current = asUri(caller.getUrl());
        if (caller != web || bindingBridge || bridgePort != null || !isTrustedPage(committed)
                || !isTrustedPage(current) || !committed.getEncodedPath().equals(current.getEncodedPath())) return;
        bindingBridge = true;
        armBridge(caller, documentGeneration, committed.getEncodedPath(), UUID.randomUUID().toString(), BRIDGE_RETRIES);
    }

    private static boolean matchesBridgePage(WebView caller, String path) {
        Uri current = asUri(caller.getUrl());
        return isTrustedPage(current) && path.equals(current.getEncodedPath());
    }

    private void armBridge(WebView caller, long generation, String path, String nonce, int remaining) {
        if (caller != web || generation != documentGeneration || !bindingBridge) return;
        if (remaining <= 0 || !matchesBridgePage(caller, path)) {
            bindingBridge = false;
            return;
        }
        // The nonce only enters this committed main document and the exact-origin
        // port message. An opaque frame cannot arm or read the receiver's nonce.
        String arm = "location.origin===" + JSONObject.quote(BundledSite.ORIGIN)
                + "&&location.pathname===" + JSONObject.quote(path)
                + "&&typeof window.FundValAndroid?.arm==='function'&&window.FundValAndroid.arm("
                + JSONObject.quote(nonce) + ")===true";
        try {
            caller.evaluateJavascript(arm, value -> {
                if (caller != web || generation != documentGeneration || !bindingBridge) return;
                if ("true".equals(value) && matchesBridgePage(caller, path)) {
                    bindingBridge = false;
                    attachBridge(caller, generation, nonce);
                } else {
                    caller.postDelayed(() -> armBridge(caller, generation, path, nonce, remaining - 1), 100);
                }
            });
        } catch (IllegalStateException | IllegalArgumentException ignored) {
            bindingBridge = false;
        }
    }

    private void attachBridge(WebView caller, long generation, String nonce) {
        WebMessagePort[] channel = null;
        try {
            channel = caller.createWebMessageChannel();
            bridgePort = channel[0];
            channel[0].setWebMessageCallback(new WebMessagePort.WebMessageCallback() {
                @Override
                public void onMessage(WebMessagePort sender, WebMessage message) {
                    receiveBridge(caller, generation, sender, message);
                }
            });
            caller.postWebMessage(new WebMessage(BRIDGE_PROTOCOL + nonce, new WebMessagePort[] { channel[1] }),
                    Uri.parse(BundledSite.ORIGIN));
        } catch (IllegalStateException | IllegalArgumentException ignored) {
            closeBridge();
            if (channel != null) closePort(channel[1]);
        }
    }

    private void receiveBridge(WebView caller, long generation, WebMessagePort sender, WebMessage message) {
        WebMessagePort[] unexpectedPorts = message.getPorts();
        if (unexpectedPorts != null && unexpectedPorts.length != 0) {
            for (WebMessagePort port : unexpectedPorts) closePort(port);
            return;
        }
        if (caller != web || generation != documentGeneration || sender != bridgePort
                || !isTrustedPage(asUri(caller.getUrl()))) return;
        String data = message.getData();
        if (data == null || data.length() > MAX_BRIDGE_CHARS) return;
        final JSONObject request;
        try {
            JSONTokener reader = new JSONTokener(data);
            Object decoded = reader.nextValue();
            if (!(decoded instanceof JSONObject) || reader.nextClean() != 0) return;
            request = (JSONObject) decoded;
        } catch (JSONException ignored) { return; }
        Object token = request.opt("id");
        if (!(token instanceof Integer) && !(token instanceof Long)) return;
        long id = ((Number) token).longValue();
        if (id < 1 || id > MAX_REQUEST_ID) return;
        Object operation = request.opt("op");
        if ("read".equals(operation) || "commit".equals(operation)) {
            storage.execute(() -> {
                JSONObject result;
                try { result = durableHoldings.handle(request); }
                catch (RuntimeException ignored) { result = error("storage_unavailable"); }
                JSONObject response = result;
                runOnUiThread(() -> reply(sender, id, response));
            });
        } else if ("export".equals(operation) && BundledSite.isHome(asUri(caller.getUrl()))) {
            Object contents = request.opt("contents");
            receiveExport(sender, id, contents instanceof String ? (String) contents : null);
        } else {
            reply(sender, id, error("unsupported_operation"));
        }
    }

    private void receiveExport(WebMessagePort sender, long id, String raw) {
        if (activePicker != 0 || writingExport || importRead != null) {
            reply(sender, id, error("picker_busy"));
            return;
        }
        if (raw == null || raw.length() > MAX_BACKUP_BYTES) {
            reply(sender, id, error("invalid_backup"));
            return;
        }
        byte[] bytes = raw.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_BACKUP_BYTES || !isBackupEnvelope(raw)) {
            reply(sender, id, error("invalid_backup"));
            return;
        }
        Intent create = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                .setType("application/json")
                .putExtra(Intent.EXTRA_TITLE, BACKUP_NAME);
        pendingExport = new PendingExport(sender, id, bytes);
        activePicker = PICK_EXPORT;
        try {
            startActivityForResult(create, PICK_EXPORT);
            safLog(PICK_EXPORT, "launched");
        } catch (ActivityNotFoundException | SecurityException ignored) {
            safLog(PICK_EXPORT, "launch_failed");
            activePicker = 0;
            pendingExport = null;
            reply(sender, id, error("picker_unavailable"));
        }
    }

    private static boolean isBackupEnvelope(String raw) {
        // The web layer already serializes the canonical holdings. The native
        // boundary checks the finite JSON envelope without recursively parsing it.
        try (JsonReader reader = new JsonReader(new StringReader(raw))) {
            boolean schema = false;
            boolean holdings = false;
            reader.beginObject();
            while (reader.hasNext()) {
                String name = reader.nextName();
                if (name.equals("schema")) {
                    if (schema || reader.peek() != JsonToken.NUMBER || reader.nextInt() != 3) return false;
                    schema = true;
                } else if (name.equals("holdings")) {
                    if (holdings || reader.peek() != JsonToken.BEGIN_ARRAY) return false;
                    reader.skipValue();
                    holdings = true;
                } else {
                    reader.skipValue();
                }
            }
            reader.endObject();
            return schema && holdings && reader.peek() == JsonToken.END_DOCUMENT;
        } catch (IOException | IllegalStateException | NumberFormatException ignored) {
            return false;
        }
    }

    private static JSONObject result(boolean ok, String key, String value) {
        try { return new JSONObject().put("ok", ok).put(key, value); }
        catch (JSONException impossible) { throw new IllegalStateException(impossible); }
    }

    private static JSONObject error(String reason) {
        return result(false, "reason", reason);
    }

    private void reply(WebMessagePort sender, long id, JSONObject response) {
        if (sender != bridgePort || web == null || !isTrustedPage(asUri(web.getUrl()))) return;
        try {
            JSONObject payload = response == null ? error("storage_unavailable") : response;
            sender.postMessage(new WebMessage(payload.put("id", id).toString()));
        } catch (IllegalStateException | JSONException ignored) { closeBridge(); }
    }

    private void closeBridge() {
        documentGeneration++;
        bindingBridge = false;
        WebMessagePort previous = bridgePort;
        bridgePort = null;
        pendingExport = null;
        closePort(previous);
    }

    private static void closePort(WebMessagePort port) {
        if (port == null) return;
        try { port.close(); }
        catch (IllegalStateException ignored) { /* Already closed or transferred. */ }
    }

    private static Uri asUri(String url) {
        return url == null ? null : Uri.parse(url);
    }

    private static Uri selectedContentUri(Intent result) {
        Uri uri = result.getData();
        ClipData clip = result.getClipData();
        if (clip != null) {
            if (clip.getItemCount() != 1) return null;
            Uri selected = clip.getItemAt(0).getUri();
            if (uri != null && !uri.equals(selected)) return null;
            uri = selected;
        }
        return uri != null && "content".equals(uri.getScheme())
                && uri.getEncodedAuthority() != null && !uri.getEncodedAuthority().isEmpty() ? uri : null;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent result) {
        super.onActivityResult(requestCode, resultCode, result);
        if (requestCode != PICK_IMPORT && requestCode != PICK_EXPORT) return;
        safLog(requestCode, resultCode == RESULT_OK ? "result_ok"
                : resultCode == RESULT_CANCELED ? "result_cancelled" : "result_other");
        if (requestCode != activePicker) {
            safLog(requestCode, "result_without_pending_picker");
            if (resultCode == RESULT_OK) toast("文件选择已中断，请重新操作");
            return;
        }
        activePicker = 0;
        Uri uri = null;
        if (resultCode == RESULT_OK) {
            if (result == null) safLog(requestCode, "result_intent_missing");
            else {
                uri = selectedContentUri(result);
                if (uri == null) safLog(requestCode, "result_uri_invalid");
            }
        }
        int grant = requestCode == PICK_IMPORT
                ? Intent.FLAG_GRANT_READ_URI_PERMISSION : Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
        // A genuine SAF result may be readable through its provider even if
        // checkUriPermission() reports no explicit grant. Require the matching
        // flag from this result and let ContentResolver enforce actual access
        // to this exact, single URI; never persist or broaden its grant.
        if (uri != null && (result.getFlags() & grant) != grant) {
            safLog(requestCode, "result_access_flag_missing");
            uri = null;
        }
        if (requestCode == PICK_IMPORT) {
            if (uri != null && importResult != null) {
                safLog(requestCode, "read_started");
                validateSelection(uri, importImages);
            } else {
                if (importResult == null) safLog(requestCode, "result_without_web_callback");
                if (resultCode == RESULT_OK) toast("无法读取所选文件，请重新选择");
                finishImport(null);
            }
            return;
        }
        PendingExport work = pendingExport;
        pendingExport = null;
        if (work == null) {
            safLog(requestCode, "result_without_export_payload");
            if (resultCode == RESULT_OK) toast("导出已中断，请重新操作");
            return;
        }
        if (uri == null) {
            reply(work.sender, work.id, resultCode == RESULT_CANCELED
                    ? result(true, "status", "cancelled") : error("invalid_destination"));
            return;
        }
        writingExport = true;
        safLog(requestCode, "write_started");
        Uri destination = uri;
        fileWriter.execute(() -> {
            boolean saved = writeBackup(destination, work.bytes);
            safLog(PICK_EXPORT, saved ? "write_finished" : "write_failed");
            runOnUiThread(() -> {
                writingExport = false;
                reply(work.sender, work.id, saved ? result(true, "status", "saved") : error("write_failed"));
            });
        });
    }

    private void validateSelection(Uri uri, boolean images) {
        CancellationSignal signal = new CancellationSignal();
        importRead = signal;
        fileWriter.execute(() -> {
            boolean valid = isBoundedSelection(uri, images, signal);
            safLog(PICK_IMPORT, signal.isCanceled() ? "read_cancelled" : valid ? "read_valid" : "read_rejected");
            runOnUiThread(() -> {
                if (importRead != signal || signal.isCanceled()) return;
                importRead = null;
                if (!valid) toast(images ? "请选择有效的 PNG、JPEG 或 WebP 截图（不超过 16 MB）"
                        : "请选择有效的 JSON 持仓文件（不超过 4 MB）");
                finishImport(valid ? uri : null);
                if (valid) safLog(PICK_IMPORT, "read_handed_to_web");
            });
        });
    }

    private boolean isBoundedSelection(Uri uri, boolean images, CancellationSignal signal) {
        int limit = images ? MAX_IMAGE_BYTES : MAX_BACKUP_BYTES;
        // Read only the provider-selected, explicitly granted URI; do not grant
        // file:// or unrestricted content:// access to the WebView.
        try (AssetFileDescriptor descriptor = getContentResolver().openAssetFileDescriptor(uri, "r", signal)) {
            if (descriptor == null || descriptor.getLength() > limit) return false;
            try (InputStream stream = descriptor.createInputStream()) {
                return BoundedSelection.valid(stream, images, limit, signal::isCanceled);
            }
        } catch (IOException | RuntimeException ignored) { return false; }
    }

    private boolean writeBackup(Uri uri, byte[] bytes) {
        try (OutputStream stream = getContentResolver().openOutputStream(uri, "wt")) {
            if (stream == null) return false;
            stream.write(bytes);
            stream.flush();
            return true;
        } catch (IOException | SecurityException | IllegalArgumentException ignored) {
            return false;
        }
    }

    private void toast(String message) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
    }

    // Fixed status labels only. Never log URI, provider, filename, contents,
    // request identity, or exception text (which can embed any of the above).
    private static void safLog(int picker, String status) {
        Log.i(SAF_LOG, (picker == PICK_IMPORT ? "open " : "create ") + status);
    }

    private void logPickerInterruption(String status) {
        if (activePicker != 0) safLog(activePicker, status);
        else if (importRead != null) safLog(PICK_IMPORT, status);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else moveTaskToBack(true); // Keep unsaved inputs alive instead of finishing the Activity.
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onDestroy() {
        logPickerInterruption(isChangingConfigurations() ? "activity_recreating" : "activity_destroyed");
        closeBridge();
        finishImport(null);
        if (web != null) {
            root.removeView(web);
            web.destroy();
            web = null;
        }
        fileWriter.shutdown();
        storage.shutdown();
        super.onDestroy();
    }
}
