package io.localfiction.harness;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.net.URI;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "NativeUpdater")
public class NativeUpdaterPlugin extends Plugin {
    private static final int DEFAULT_JSON_MAX_BYTES = 2 * 1024 * 1024;
    private static final long DEFAULT_APK_MAX_BYTES = 200L * 1024L * 1024L;
    private static final String UPDATES_DIR_NAME = "updates";
    private static final String APK_MIME_TYPE = "application/vnd.android.package-archive";

    private final ApkUpdateClient updateClient = new ApkUpdateClient();
    private final ExecutorService executor = Executors.newCachedThreadPool();

    @PluginMethod
    public void fetchReleasesJson(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.trim().isEmpty()) {
            call.reject("url is required.");
            return;
        }
        Integer maxBytesObj = call.getInt("maxBytes", DEFAULT_JSON_MAX_BYTES);
        int maxBytes = (maxBytesObj != null && maxBytesObj > 0) ? maxBytesObj : DEFAULT_JSON_MAX_BYTES;

        executor.submit(() -> {
            try {
                String json = updateClient.fetchJson(url, maxBytes);
                JSObject result = new JSObject();
                result.put("json", json);
                call.resolve(result);
            } catch (ApkUpdateClient.HttpStatusException err) {
                call.reject(
                    "HTTP " + err.getStatus() + ": " + err.getMessage(),
                    "HTTP_" + err.getStatus(),
                    err
                );
            } catch (Exception err) {
                String msg = err.getMessage();
                call.reject(msg != null && !msg.isEmpty() ? msg : err.getClass().getSimpleName(), err);
            }
        });
    }

    @PluginMethod
    public void downloadAndVerifyApk(PluginCall call) {
        String requestId = call.getString("requestId");
        String url = call.getString("url");
        String version = call.getString("version");
        String expectedSha256 = call.getString("expectedSha256");
        Long maxBytesObj = call.getLong("maxBytes", DEFAULT_APK_MAX_BYTES);
        long maxBytes = (maxBytesObj != null && maxBytesObj > 0) ? maxBytesObj : DEFAULT_APK_MAX_BYTES;

        if (requestId == null || requestId.isEmpty()
            || url == null || url.trim().isEmpty()
            || version == null || version.trim().isEmpty()) {
            call.reject("requestId, url, and version are required.");
            return;
        }

        File updatesDir = getUpdatesDir();
        ApkUpdateClient.ApkVerifier verifier = createApkVerifier();

        updateClient.downloadAndVerifyApk(
            requestId,
            url,
            updatesDir,
            version,
            expectedSha256,
            maxBytes,
            verifier,
            new ApkUpdateClient.Listener() {
                @Override
                public void onProgress(String reqId, long downloadedBytes, long totalBytes) {
                    JSObject data = new JSObject();
                    data.put("requestId", reqId);
                    data.put("downloadedBytes", downloadedBytes);
                    data.put("totalBytes", totalBytes);
                    notifyListeners("updateProgress", data);
                }

                @Override
                public void onComplete(
                    String reqId,
                    String fileName,
                    String ver,
                    String sha256,
                    long sizeBytes,
                    boolean reusedCache
                ) {
                    JSObject data = new JSObject();
                    data.put("requestId", reqId);
                    data.put("fileName", fileName);
                    data.put("version", ver);
                    data.put("sha256", sha256);
                    data.put("sizeBytes", sizeBytes);
                    data.put("reusedCache", reusedCache);
                    notifyListeners("updateComplete", data);
                }

                @Override
                public void onError(String reqId, int status, String code, String message, boolean aborted) {
                    JSObject data = new JSObject();
                    data.put("requestId", reqId);
                    if (status > 0) {
                        data.put("status", status);
                    }
                    data.put("code", code != null ? code : "DOWNLOAD_FAILED");
                    data.put("message", message != null ? message : "Update download failed.");
                    data.put("aborted", aborted);
                    notifyListeners("updateError", data);
                }
            }
        );

        call.resolve();
    }

    @PluginMethod
    public void abortDownload(PluginCall call) {
        String requestId = call.getString("requestId");
        if (requestId != null && !requestId.isEmpty()) {
            updateClient.abortDownload(requestId);
        }
        call.resolve();
    }

    @PluginMethod
    public void canRequestPackageInstalls(PluginCall call) {
        JSObject result = new JSObject();
        result.put("allowed", hasPackageInstallPermission());
        call.resolve(result);
    }

    @PluginMethod
    public void openInstallPermissionSettings(PluginCall call) {
        Context context = getContext();
        Uri packageUri = Uri.parse("package:" + context.getPackageName());
        Intent intent = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            ? new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, packageUri)
            : new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, packageUri);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

        try {
            context.startActivity(intent);
        } catch (ActivityNotFoundException err) {
            Intent fallback = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, packageUri);
            fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                context.startActivity(fallback);
            } catch (Exception fallbackErr) {
                call.reject("Unable to open install permission settings: " + fallbackErr.getMessage(), fallbackErr);
                return;
            }
        } catch (Exception err) {
            call.reject("Unable to open install permission settings: " + err.getMessage(), err);
            return;
        }
        call.resolve();
    }

    @PluginMethod
    public void installDownloadedApk(PluginCall call) {
        if (!hasPackageInstallPermission()) {
            call.reject("PERMISSION_DENIED: Install permission for unknown apps is not granted.");
            return;
        }

        String version = call.getString("version");
        if (version == null || version.trim().isEmpty()) {
            call.reject("version is required.");
            return;
        }

        File apkFile = new File(getUpdatesDir(), ApkUpdateClient.buildApkFileName(version));
        if (!apkFile.isFile() || apkFile.length() <= 0) {
            call.reject("APK_NOT_FOUND: Downloaded APK file does not exist.");
            return;
        }

        ApkUpdateClient.VerificationResult verification = createApkVerifier().verify(apkFile);
        if (verification == null || !verification.ok) {
            String code = (verification != null && verification.errorCode != null)
                ? verification.errorCode
                : "VERIFICATION_FAILED";
            String msg = (verification != null && verification.errorMessage != null)
                ? verification.errorMessage
                : "APK verification failed.";
            call.reject(code + ": " + msg);
            return;
        }

        try {
            Context context = getContext();
            Uri apkUri = FileProvider.getUriForFile(
                context,
                context.getPackageName() + ".fileprovider",
                apkFile
            );
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(apkUri, APK_MIME_TYPE);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
            call.resolve();
        } catch (Exception err) {
            call.reject("Failed to launch APK installer: " + err.getMessage(), err);
        }
    }

    @PluginMethod
    public void cleanupStaleApks(PluginCall call) {
        String keepVersion = call.getString("keepVersion");
        ApkUpdateClient.cleanupStaleApks(getUpdatesDir(), keepVersion);
        call.resolve();
    }

    @PluginMethod
    public void openExternalUrl(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.trim().isEmpty()) {
            call.reject("url is required.");
            return;
        }
        String trimmed = url.trim();
        try {
            URI uri = URI.create(trimmed);
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getHost().isEmpty()) {
                call.reject("Only secure HTTPS (https://) URLs are allowed.");
                return;
            }
        } catch (IllegalArgumentException err) {
            call.reject("Invalid URL: " + err.getMessage(), err);
            return;
        }

        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(trimmed));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception err) {
            call.reject("Failed to open external URL: " + err.getMessage(), err);
        }
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        notifyListeners("appResumed", new JSObject());
    }

    @Override
    protected void handleOnDestroy() {
        updateClient.shutdown();
        executor.shutdownNow();
        super.handleOnDestroy();
    }

    private File getUpdatesDir() {
        return new File(getContext().getCacheDir(), UPDATES_DIR_NAME);
    }

    private boolean hasPackageInstallPermission() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.O
            || getContext().getPackageManager().canRequestPackageInstalls();
    }

    private ApkUpdateClient.ApkVerifier createApkVerifier() {
        Context context = getContext().getApplicationContext();
        return apkFile -> verifyApkPackageAndSignature(context, apkFile);
    }

    private static ApkUpdateClient.VerificationResult verifyApkPackageAndSignature(Context context, File apkFile) {
        if (apkFile == null || !apkFile.isFile()) {
            return ApkUpdateClient.VerificationResult.fail("INVALID_APK", "APK file does not exist.");
        }
        try {
            PackageManager pm = context.getPackageManager();
            String expectedPackageName = context.getPackageName();
            int flags = getSigningFlags();

            PackageInfo archiveInfo = pm.getPackageArchiveInfo(apkFile.getAbsolutePath(), flags);
            if (archiveInfo == null
                || archiveInfo.packageName == null
                || !archiveInfo.packageName.equals(expectedPackageName)) {
                return ApkUpdateClient.VerificationResult.fail(
                    "PACKAGE_MISMATCH",
                    "Downloaded APK package name does not match the installed application."
                );
            }

            PackageInfo installedInfo = pm.getPackageInfo(expectedPackageName, flags);
            Set<String> archiveCerts = extractCertificateSha256Set(archiveInfo);
            Set<String> installedCerts = extractCertificateSha256Set(installedInfo);

            if (archiveCerts.isEmpty() || installedCerts.isEmpty() || !archiveCerts.equals(installedCerts)) {
                return ApkUpdateClient.VerificationResult.fail(
                    "SIGNATURE_MISMATCH",
                    "Downloaded APK signing certificate does not match the installed application."
                );
            }
            return ApkUpdateClient.VerificationResult.ok();
        } catch (Exception err) {
            return ApkUpdateClient.VerificationResult.fail(
                "SIGNATURE_MISMATCH",
                "Failed to verify APK signing certificate: " + err.getMessage()
            );
        }
    }

    @SuppressWarnings("deprecation")
    private static int getSigningFlags() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
            ? PackageManager.GET_SIGNING_CERTIFICATES
            : PackageManager.GET_SIGNATURES;
    }

    @SuppressWarnings("deprecation")
    private static Set<String> extractCertificateSha256Set(PackageInfo packageInfo)
        throws NoSuchAlgorithmException {
        Set<String> digests = new HashSet<>();
        if (packageInfo == null) {
            return digests;
        }
        Signature[] signatures = null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            SigningInfo signingInfo = packageInfo.signingInfo;
            if (signingInfo != null) {
                signatures = signingInfo.hasMultipleSigners()
                    ? signingInfo.getApkContentsSigners()
                    : signingInfo.getSigningCertificateHistory();
            }
        } else {
            signatures = packageInfo.signatures;
        }
        if (signatures == null) {
            return digests;
        }
        MessageDigest sha256 = MessageDigest.getInstance("SHA-256");
        for (Signature signature : signatures) {
            if (signature == null) {
                continue;
            }
            byte[] encoded = signature.toByteArray();
            if (encoded == null || encoded.length == 0) {
                continue;
            }
            sha256.reset();
            byte[] hash = sha256.digest(encoded);
            digests.add(toHexLower(hash));
        }
        return digests;
    }

    private static String toHexLower(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(Character.forDigit((b >> 4) & 0xF, 16));
            sb.append(Character.forDigit(b & 0xF, 16));
        }
        return sb.toString();
    }
}
