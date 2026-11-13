package app.atlas.android

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

const val CHANNEL_ID = "atlas-reminders-v1"
const val EXTRA_ALARM_ID = "atlas_alarm_id"
const val EXTRA_TASK_ID = "atlas_task_id"

/** Arming, firing and showing, shared by the plugin (app running) and the receivers (app closed). */
object Reminders {
  fun ensureChannel(context: Context) {
    val m = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (m.getNotificationChannel(CHANNEL_ID) == null) {
      val c = NotificationChannel(CHANNEL_ID, "Reminders", NotificationManager.IMPORTANCE_HIGH)
      c.description = "Task reminders from your Atlas server"
      m.createNotificationChannel(c)
    }
  }

  fun canExact(context: Context): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
    return (context.getSystemService(Context.ALARM_SERVICE) as AlarmManager).canScheduleExactAlarms()
  }

  private fun alarmIntent(context: Context, id: Int): PendingIntent {
    val i = Intent(context, AlarmReceiver::class.java).putExtra(EXTRA_ALARM_ID, id)
    return PendingIntent.getBroadcast(context, id, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  /**
   * Arm the OS alarm. Exact when allowed; otherwise the best inexact one (reported by the plugin's status).
   * `setAlarmClock` is used because it is the one call vendors do not batch or delay: on a OnePlus 8T (OxygenOS 14) an exact
   * `setExactAndAllowWhileIdle` alarm was still turned into a window of up to 75 % of the delay (SYNC-07 S5, ACCEPTANCE).
   * The price is the system's "next alarm" indicator while a reminder is pending.
   */
  fun arm(context: Context, a: StoredAlarm) {
    val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
    val pi = alarmIntent(context, a.id)
    if (canExact(context)) {
      val show = context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
        PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      } ?: pi
      am.setAlarmClock(AlarmManager.AlarmClockInfo(a.at, show), pi)
    } else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, a.at, pi)
  }

  fun disarm(context: Context, id: Int) {
    (context.getSystemService(Context.ALARM_SERVICE) as AlarmManager).cancel(alarmIntent(context, id))
  }

  /** Post the notification. A tap opens the app with the task id. Returns false when the OS refuses (no permission). */
  fun post(context: Context, a: StoredAlarm): Boolean {
    ensureChannel(context)
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
      a.taskId?.let { putExtra(EXTRA_TASK_ID, it) }
    }
    val tap = launch?.let { PendingIntent.getActivity(context, a.id, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE) }
    val n = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(context.applicationInfo.icon.takeIf { it != 0 } ?: android.R.drawable.ic_popup_reminder)
      .setContentTitle(a.title).setContentText(a.body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(a.body))
      .setCategory(NotificationCompat.CATEGORY_REMINDER).setPriority(NotificationCompat.PRIORITY_HIGH)
      .setAutoCancel(true).setContentIntent(tap).build()
    return try {
      if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) false
      else { NotificationManagerCompat.from(context).notify(a.id, n); true }
    } catch (_: SecurityException) { false }
  }

  /** Re-arm after a reboot, an app update or a clock change. Alarms already due are shown now (missed while the phone was off). */
  fun rearmAll(context: Context) {
    val store = AlarmStore(context)
    val now = System.currentTimeMillis()
    for (a in store.pending()) {
      if (a.at <= now) fire(context, a.id) else arm(context, a)
    }
  }

  /** The alarm is due: show it, log the delivery, forget the pending entry. */
  fun fire(context: Context, id: Int) {
    val store = AlarmStore(context)
    val a = store.get(id) ?: return
    post(context, a)
    store.logDelivered(id)
    store.remove(id)
  }
}
