package app.atlas.android

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/** One reminder alarm as stored. The text is final (the core decided generic or full content). */
data class StoredAlarm(val id: Int, val at: Long, val title: String, val body: String, val taskId: String?, val key: String?) {
  fun toJson(): JSONObject = JSONObject().put("id", id).put("at", at).put("title", title).put("body", body)
    .put("taskId", taskId ?: JSONObject.NULL).put("key", key ?: JSONObject.NULL)

  companion object {
    fun fromJson(o: JSONObject) = StoredAlarm(
      o.getInt("id"), o.getLong("at"), o.getString("title"), o.getString("body"),
      if (o.isNull("taskId")) null else o.getString("taskId"),
      if (o.isNull("key")) null else o.getString("key"),
    )
  }
}

/**
 * Durable state of the alarm subsystem, in app-private SharedPreferences (`commit()`, so a process death right after a write
 * cannot lose it). AlarmManager forgets everything on reboot, so the pending set lives here and the boot receiver re-arms it.
 * Receivers use this without the app process (and without the webview) being alive.
 */
class AlarmStore(context: Context) {
  private val prefs = context.applicationContext.getSharedPreferences("atlas_alarms", Context.MODE_PRIVATE)

  @Synchronized fun pending(): List<StoredAlarm> {
    val o = JSONObject(prefs.getString("pending", "{}") ?: "{}")
    return o.keys().asSequence().mapNotNull { runCatching { StoredAlarm.fromJson(o.getJSONObject(it)) }.getOrNull() }.toList()
  }

  @Synchronized fun get(id: Int): StoredAlarm? = pending().firstOrNull { it.id == id }

  @Synchronized fun put(a: StoredAlarm) {
    val o = JSONObject(prefs.getString("pending", "{}") ?: "{}")
    o.put(a.id.toString(), a.toJson())
    prefs.edit().putString("pending", o.toString()).commit()
  }

  @Synchronized fun remove(id: Int) {
    val o = JSONObject(prefs.getString("pending", "{}") ?: "{}")
    o.remove(id.toString())
    prefs.edit().putString("pending", o.toString()).commit()
  }

  /** The delivery log: ids the OS showed while the app may have been closed. Taken (and cleared) by the app. */
  @Synchronized fun logDelivered(id: Int) {
    val a = JSONArray(prefs.getString("delivered", "[]") ?: "[]")
    a.put(id)
    prefs.edit().putString("delivered", a.toString()).commit()
  }

  @Synchronized fun takeDelivered(): List<Int> {
    val a = JSONArray(prefs.getString("delivered", "[]") ?: "[]")
    prefs.edit().putString("delivered", "[]").commit()
    return (0 until a.length()).map { a.getInt(it) }
  }

  /** The person's choice for the "keep Atlas connected" mode (ADR-0075 D7). */
  @Synchronized fun keepConnected(): Boolean = prefs.getBoolean("keep_connected", false)

  @Synchronized fun setKeepConnected(on: Boolean) {
    prefs.edit().putBoolean("keep_connected", on).commit()
  }

  @Synchronized fun setLaunchTask(taskId: String?) {
    prefs.edit().apply { if (taskId == null) remove("launch_task") else putString("launch_task", taskId) }.commit()
  }

  @Synchronized fun takeLaunchTask(): String? {
    val v = prefs.getString("launch_task", null)
    if (v != null) prefs.edit().remove("launch_task").commit()
    return v
  }
}
