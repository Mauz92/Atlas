package app.atlas.android

import android.Manifest
import android.app.Activity
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg class TokenArgs { lateinit var token: String }
@InvokeArg class IdArgs { var id: Int = 0 }
@InvokeArg class OnArgs { var on: Boolean = false }
@InvokeArg class IdsArgs { var ids: List<Int> = listOf() }
@InvokeArg class WhichArgs { lateinit var which: String }
@InvokeArg class ShareArgs {
  lateinit var path: String
  var mime: String = "application/octet-stream"
  var title: String = ""
}
@InvokeArg class AlarmArgs {
  var id: Int = 0
  var at: Long = 0
  var title: String = ""
  var body: String = ""
  var taskId: String? = null
  var key: String? = null
}

private const val NOTIFICATIONS = "notifications"

@TauriPlugin(permissions = [Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = NOTIFICATIONS)])
class AtlasAndroidPlugin(private val activity: Activity) : Plugin(activity) {
  private val store by lazy { AlarmStore(activity) }
  private val secure by lazy { SecureToken(activity) }

  private var page: android.webkit.WebView? = null

  /** Tell the page the app came to the front. The WebView keeps reporting "visible" while the activity is in the background (seen on OxygenOS 14), so the page cannot find out by itself. */
  private fun tellPage() {
    page?.post { page?.evaluateJavascript("window.dispatchEvent(new Event('atlas-native-resume'))", null) }
  }

  override fun onResume(activity: androidx.appcompat.app.AppCompatActivity) {
    super.onResume(activity)
    tellPage()
  }

  override fun load(webView: android.webkit.WebView) {
    super.load(webView)
    page = webView
    Reminders.ensureChannel(activity)
    activity.intent?.let { remember(it) }
    if (store.keepConnected()) runCatching { KeepConnectedService.start(activity) } // the app is in front here, so a foreground service may start
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    remember(intent)
    tellPage()
  }

  /** A tapped reminder carries the task id; the page asks for it (once) when it regains focus. */
  private fun remember(intent: Intent) {
    intent.getStringExtra(EXTRA_TASK_ID)?.let { store.setLaunchTask(it); intent.removeExtra(EXTRA_TASK_ID) }
  }

  private fun fail(invoke: Invoke, e: Throwable) = invoke.reject(e.javaClass.simpleName + ": " + (e.message ?: ""))

  @Command fun tokenSet(invoke: Invoke) {
    try { secure.set(invoke.parseArgs(TokenArgs::class.java).token); invoke.resolve() } catch (e: Throwable) { fail(invoke, e) }
  }

  @Command fun tokenGet(invoke: Invoke) {
    try {
      val o = JSObject(); o.put("value", secure.get() ?: org.json.JSONObject.NULL); invoke.resolve(o)
    } catch (e: Throwable) { fail(invoke, e) }
  }

  @Command fun tokenDelete(invoke: Invoke) {
    try { secure.delete(); invoke.resolve() } catch (e: Throwable) { fail(invoke, e) }
  }

  @Command fun alarmSchedule(invoke: Invoke) {
    try {
      val a = invoke.parseArgs(AlarmArgs::class.java)
      val s = StoredAlarm(a.id, a.at, a.title, a.body, a.taskId, a.key)
      store.put(s)
      Reminders.arm(activity, s)
      invoke.resolve()
    } catch (e: Throwable) { fail(invoke, e) }
  }

  @Command fun alarmCancel(invoke: Invoke) {
    try {
      val id = invoke.parseArgs(IdArgs::class.java).id
      Reminders.disarm(activity, id); store.remove(id); invoke.resolve()
    } catch (e: Throwable) { fail(invoke, e) }
  }

  @Command fun alarmList(invoke: Invoke) {
    val arr = JSArray()
    for (a in store.pending()) arr.put(JSObject().put("id", a.id).put("at", a.at))
    invoke.resolve(JSObject().put("value", arr))
  }

  @Command fun delivered(invoke: Invoke) {
    val ids = LinkedHashSet<Int>(store.takeDelivered())
    val nm = activity.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    nm.activeNotifications.forEach { ids.add(it.id) }
    val arr = JSArray(); ids.forEach { arr.put(it) }
    invoke.resolve(JSObject().put("value", arr))
  }

  @Command fun show(invoke: Invoke) {
    val a = invoke.parseArgs(AlarmArgs::class.java)
    Reminders.post(activity, StoredAlarm(a.id, a.at, a.title, a.body, a.taskId, a.key))
    invoke.resolve()
  }

  @Command fun clearShown(invoke: Invoke) {
    val nm = NotificationManagerCompat.from(activity)
    invoke.parseArgs(IdsArgs::class.java).ids.forEach { nm.cancel(it) }
    invoke.resolve()
  }

  private fun notificationState(): String =
    if (NotificationManagerCompat.from(activity).areNotificationsEnabled()) "granted"
    else if (Build.VERSION.SDK_INT >= 33 && getPermissionState(NOTIFICATIONS) == PermissionState.PROMPT) "prompt" else "denied"

  @Command fun status(invoke: Invoke) {
    val pm = activity.getSystemService(Context.POWER_SERVICE) as PowerManager
    invoke.resolve(
      JSObject().put("notifications", notificationState()).put("exactAlarms", Reminders.canExact(activity))
        .put("ignoringBatteryOptimizations", pm.isIgnoringBatteryOptimizations(activity.packageName))
        .put("allFilesAccess", if (Build.VERSION.SDK_INT >= 30) android.os.Environment.isExternalStorageManager() else false)
        .put("manufacturer", Build.MANUFACTURER).put("sdk", Build.VERSION.SDK_INT)
    )
  }

  @Command fun requestNotifications(invoke: Invoke) {
    if (Build.VERSION.SDK_INT >= 33 && getPermissionState(NOTIFICATIONS) != PermissionState.GRANTED) {
      requestPermissionForAlias(NOTIFICATIONS, invoke, "notificationsResult")
    } else invoke.resolve(JSObject().put("value", notificationState()))
  }

  @PermissionCallback private fun notificationsResult(invoke: Invoke) {
    invoke.resolve(JSObject().put("value", notificationState()))
  }

  /** Optional background mode: a foreground service keeps the process (and the live connection) alive. Persisted; off by default. */
  @Command fun keepConnectedSet(invoke: Invoke) {
    try {
      val on = invoke.parseArgs(OnArgs::class.java).on
      store.setKeepConnected(on)
      if (on) KeepConnectedService.start(activity) else KeepConnectedService.stop(activity)
      invoke.resolve()
    } catch (e: Throwable) { fail(invoke, e) }
  }

  @Command fun keepConnectedGet(invoke: Invoke) {
    invoke.resolve(JSObject().put("value", store.keepConnected()))
  }

  /** The shared notes folder, `Documents/Atlas Notes` on the primary shared storage. */
  @Command fun sharedNotesPath(invoke: Invoke) {
    val dir = java.io.File(android.os.Environment.getExternalStorageDirectory(), "Documents/Atlas Notes")
    invoke.resolve(JSObject().put("value", dir.absolutePath))
  }

  @Command fun takeLaunchTask(invoke: Invoke) {
    invoke.resolve(JSObject().put("value", store.takeLaunchTask() ?: org.json.JSONObject.NULL))
  }

  /** Share one file from the app's own cache. The path is checked to be inside it, so the page cannot make the host share anything else. */
  @Command fun shareFile(invoke: Invoke) {
    try {
      val a = invoke.parseArgs(ShareArgs::class.java)
      val file = java.io.File(a.path).canonicalFile
      val cache = activity.cacheDir.canonicalFile
      if (!file.path.startsWith(cache.path + "/") || !file.isFile) throw IllegalArgumentException("not a file in the app cache")
      val uri = androidx.core.content.FileProvider.getUriForFile(activity, activity.packageName + ".fileprovider", file)
      val send = Intent(Intent.ACTION_SEND).setType(a.mime).putExtra(Intent.EXTRA_STREAM, uri).putExtra(Intent.EXTRA_SUBJECT, a.title)
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      activity.startActivity(Intent.createChooser(send, a.title))
      invoke.resolve()
    } catch (e: Throwable) { fail(invoke, e) }
  }

  @Command fun openSettings(invoke: Invoke) {
    val pkg = Uri.parse("package:" + activity.packageName)
    val i = when (invoke.parseArgs(WhichArgs::class.java).which) {
      "notifications" -> Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, activity.packageName)
      "battery" -> Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
      "all_files" -> if (Build.VERSION.SDK_INT >= 30) Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, pkg) else Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg)
      "exact_alarms" -> if (Build.VERSION.SDK_INT >= 31) Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, pkg) else Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg)
      else -> Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg)
    }
    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try { activity.startActivity(i); invoke.resolve() } catch (e: Throwable) { fail(invoke, e) }
  }
}
