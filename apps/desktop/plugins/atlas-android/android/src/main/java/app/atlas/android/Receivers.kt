package app.atlas.android

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class AlarmReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val id = intent.getIntExtra(EXTRA_ALARM_ID, -1)
    if (id >= 0) Reminders.fire(context, id)
  }
}

class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    Reminders.rearmAll(context)
  }
}
