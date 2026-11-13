package app.atlas.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Optional "keep Atlas connected" mode (off by default, ADR-0075 D7). The sync engine runs in the app's WebView, so something has to keep
 * the app's process (and its live connection) alive while the screen is off or another app is in front. A foreground service with a
 * visible, low-priority notification does that; it does nothing else. It cannot start the app after a reboot (no WebView then): open
 * Atlas once after a restart.
 */
class KeepConnectedService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val m = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (m.getNotificationChannel(CHANNEL) == null) {
      m.createNotificationChannel(NotificationChannel(CHANNEL, "Atlas connection", NotificationManager.IMPORTANCE_LOW).apply {
        description = "Shown while Atlas keeps itself connected in the background"
        setShowBadge(false)
      })
    }
    val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
    val n: Notification = NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(applicationInfo.icon.takeIf { it != 0 } ?: android.R.drawable.ic_popup_sync)
      .setContentTitle("Atlas is connected")
      .setContentText("Keeping your reminders up to date. Turn this off in Settings > This app.")
      .setOngoing(true).setOnlyAlertOnce(true).setCategory(NotificationCompat.CATEGORY_SERVICE).setContentIntent(open).build()
    if (Build.VERSION.SDK_INT >= 34) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE) else startForeground(ID, n)
    return START_STICKY
  }

  companion object {
    private const val CHANNEL = "atlas-connection-v1"
    private const val ID = 7001

    fun start(context: Context) {
      androidx.core.content.ContextCompat.startForegroundService(context, Intent(context, KeepConnectedService::class.java))
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, KeepConnectedService::class.java))
    }
  }
}
