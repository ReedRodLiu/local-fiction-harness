package io.localfiction.harness;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

/**
 * Lightweight dataSync ForegroundService used only while one or more SSE model streams are active.
 * Keeps the app process network-eligible when the user switches apps or locks the screen, and
 * shuts down immediately once all active streams complete, fail, or are aborted.
 */
public class SseForegroundService extends Service {
    static final String ACTION_START = "io.localfiction.harness.action.START_SSE_KEEPALIVE";
    private static final String CHANNEL_ID = "folio_sse_keepalive";
    private static final String CHANNEL_NAME = "后台流式生成保活";
    private static final int NOTIFICATION_ID = 14801;

    static void startKeepalive(Context context) {
        if (context == null) {
            return;
        }
        Context appContext = context.getApplicationContext();
        Intent intent = new Intent(appContext, SseForegroundService.class).setAction(ACTION_START);
        try {
            ContextCompat.startForegroundService(appContext, intent);
        } catch (RuntimeException ignored) {
            // Android 12+ may restrict background FGS starts; WakeLock + socket remain guarded in plugin.
        }
    }

    static void stopKeepalive(Context context) {
        if (context == null) {
            return;
        }
        Context appContext = context.getApplicationContext();
        try {
            appContext.stopService(new Intent(appContext, SseForegroundService.class));
        } catch (RuntimeException ignored) {
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        ensureNotificationChannel();
        Notification notification = buildNotification();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                );
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
        } catch (RuntimeException ignored) {
            // Degrade safely if Android 13+ notification permission is denied or FGS start is rejected.
            stopSelf(startId);
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onTimeout(int startId, int fgsType) {
        stopForegroundSafely();
        stopSelf(startId);
    }

    @Override
    public void onDestroy() {
        stopForegroundSafely();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) {
            return;
        }
        if (manager.getNotificationChannel(CHANNEL_ID) != null) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            CHANNEL_NAME,
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("仅在模型流式生成期间保持后台网络连接，生成结束后自动关闭。");
        channel.setShowBadge(false);
        channel.enableLights(false);
        channel.enableVibration(false);
        channel.setSound(null, null);
        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification() {
        Intent launchIntent = new Intent(this, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(
            this,
            0,
            launchIntent,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle(getString(R.string.app_name))
            .setContentText("Folio 正在生成回复…")
            .setOngoing(true)
            .setSilent(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(contentIntent)
            .build();
    }

    private void stopForegroundSafely() {
        try {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } catch (RuntimeException ignored) {
        }
    }
}
