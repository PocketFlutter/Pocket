package dev.pocketjs.pocket_platform

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProviderInfo
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.PluginRegistry
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

/**
 * Shared persistence & event helper callable by scaffolded consumer
 * `AppWidgetProvider`, `BroadcastReceiver`, and Wear OS companion services.
 */
object PocketSurfaceBridgeStore {
    const val PREFS_NAME = "dev.pocketjs.surfaces"
    const val SNAPSHOT_KEY = "snapshot_v1"
    const val PENDING_ACTIONS_KEY = "pending_actions_v1"
    private const val MAX_QUEUED_ACTIONS = 32

    @Volatile
    internal var liveSurfaceChannel: MethodChannel? = null

    @JvmStatic
    fun readLatestSnapshotJson(context: Context): String? {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getString(SNAPSHOT_KEY, null)
    }

    @JvmStatic
    fun enqueueWidgetAction(
        context: Context,
        id: String,
        href: String,
        source: String = "android-widget",
    ) {
        if (id.isBlank() || href.isBlank()) return
        val timestampMs = System.currentTimeMillis()
        val applicationContext = context.applicationContext
        val deliver = Runnable {
            val channel = liveSurfaceChannel
            if (channel == null) {
                queueAction(applicationContext, id, href, source, timestampMs)
                return@Runnable
            }
            channel.invokeMethod(
                "onWidgetAction",
                mapOf(
                    "id" to id,
                    "href" to href,
                    "source" to source,
                    "timestampMs" to timestampMs,
                ),
                object : MethodChannel.Result {
                    override fun success(result: Any?) {
                        if (result != true) queueAction(applicationContext, id, href, source, timestampMs)
                    }

                    override fun error(errorCode: String, errorMessage: String?, errorDetails: Any?) {
                        queueAction(applicationContext, id, href, source, timestampMs)
                    }

                    override fun notImplemented() {
                        queueAction(applicationContext, id, href, source, timestampMs)
                    }
                },
            )
            Uri.parse(href)?.let { PocketPlatformPlugin.handleIncomingUri(it) }
        }
        if (Looper.myLooper() == Looper.getMainLooper()) {
            deliver.run()
        } else {
            Handler(Looper.getMainLooper()).post(deliver)
        }
    }

    @Synchronized
    private fun queueAction(context: Context, id: String, href: String, source: String, timestampMs: Long) {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val raw = prefs.getString(PENDING_ACTIONS_KEY, "[]") ?: "[]"
        val arr = try {
            JSONArray(raw)
        } catch (_: Exception) {
            JSONArray()
        }
        val nextArr = JSONArray()
        val startIdx = (arr.length() - (MAX_QUEUED_ACTIONS - 1)).coerceAtLeast(0)
        for (i in startIdx until arr.length()) {
            nextArr.put(arr.optJSONObject(i))
        }
        nextArr.put(
            JSONObject().apply {
                put("id", id)
                put("href", href)
                put("source", source)
                put("timestampMs", timestampMs)
            },
        )
        prefs.edit().putString(PENDING_ACTIONS_KEY, nextArr.toString()).apply()
    }

    @JvmStatic
    @Synchronized
    fun drainPendingActions(context: Context): List<Map<String, Any>> {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val raw = prefs.getString(PENDING_ACTIONS_KEY, null) ?: return emptyList()
        prefs.edit().remove(PENDING_ACTIONS_KEY).apply()
        val arr = try {
            JSONArray(raw)
        } catch (_: Exception) {
            return emptyList()
        }
        val list = mutableListOf<Map<String, Any>>()
        for (i in 0 until arr.length()) {
            val obj = arr.optJSONObject(i) ?: continue
            val id = obj.optString("id", "").trim()
            val href = obj.optString("href", "").trim()
            if (id.isEmpty() || href.isEmpty()) continue
            list.add(
                mapOf(
                    "id" to id,
                    "href" to href,
                    "source" to obj.optString("source", "android-widget"),
                    "timestampMs" to obj.optLong("timestampMs", System.currentTimeMillis()),
                ),
            )
        }
        return list
    }
}

/**
 * Native half of the opt-in links and ecosystem surfaces provider.
 *
 * This plugin does not add an intent filter. The trusted consumer owns its
 * scheme declaration and forwards explicit intents through the standard
 * Flutter activity lifecycle.
 */
class PocketPlatformPlugin : FlutterPlugin, MethodChannel.MethodCallHandler,
    ActivityAware, PluginRegistry.NewIntentListener {

    companion object {
        private const val CHANNEL_NAME = "com.pocketnexus.host/platform"
        private const val SURFACES_CHANNEL_NAME = "com.pocketnexus.host/surfaces"
        private const val ENABLED_KEY = "dev.pocketjs.platform.DEEP_LINKS_ENABLED"
        private const val SCHEMES_KEY = "dev.pocketjs.platform.DEEP_LINK_SCHEMES"
        private const val LIVE_UPDATE_CHANNEL_ID = "pocket_live_updates"
        private const val LIVE_UPDATE_NOTIFICATION_ID = 48192

        @Volatile
        private var shared: PocketPlatformPlugin? = null

        /** Forward a cold/warm URL from the consuming Activity. */
        @JvmStatic
        fun handleIncomingUri(uri: Uri) {
            shared?.receive(uri)
        }
    }

    private var applicationContext: Context? = null
    private var activity: Activity? = null
    private var activityBinding: ActivityPluginBinding? = null
    private var channel: MethodChannel? = null
    private var surfacesChannel: MethodChannel? = null
    private var linksEnabled = false
    private var configuredScheme: String? = null
    private var initialLink: String? = null
    private var latestLink: String? = null
    private data class RecentUri(val value: String, val atMillis: Long)
    private val recentUris = java.util.ArrayDeque<RecentUri>()
    private val deepLinkDedupeWindowMillis = 250L
    private val maxRecentUris = 32
    private var intentListenerAttached = false
    // A trusted static opt-in may deliver a cold launch intent before the Dart
    // isolate activates the provider. disableDeepLinks closes this window.
    private var preconfigurationCaptureOpen = true

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        applicationContext = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, CHANNEL_NAME)
        channel?.setMethodCallHandler(this)
        surfacesChannel = MethodChannel(binding.binaryMessenger, SURFACES_CHANNEL_NAME)
        surfacesChannel?.setMethodCallHandler(::onSurfaceMethodCall)
        shared = this
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        disableDeepLinks()
        if (PocketSurfaceBridgeStore.liveSurfaceChannel === surfacesChannel) {
            PocketSurfaceBridgeStore.liveSurfaceChannel = null
        }
        surfacesChannel?.setMethodCallHandler(null)
        surfacesChannel = null
        channel?.setMethodCallHandler(null)
        channel = null
        applicationContext = null
        if (shared === this) shared = null
    }

    override fun onAttachedToActivity(binding: ActivityPluginBinding) {
        activityBinding = binding
        activity = binding.activity
        if (linksEnabled) attachIntentListener()
    }

    override fun onDetachedFromActivityForConfigChanges() {
        detachActivity()
    }

    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) {
        onAttachedToActivity(binding)
    }

    override fun onDetachedFromActivity() {
        detachActivity()
    }

    override fun onNewIntent(intent: Intent): Boolean {
        intent.data?.let(::receive)
        return false
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "configureDeepLinks" -> configureDeepLinks(call.arguments, result)
            "getInitialLink" -> result.success(mapOf("uri" to initialLink))
            "getLatestLink" -> result.success(mapOf("uri" to latestLink))
            "disableDeepLinks" -> {
                disableDeepLinks()
                result.success(mapOf("disabled" to true))
            }
            else -> result.notImplemented()
        }
    }

    private fun onSurfaceMethodCall(call: MethodCall, result: MethodChannel.Result) {
        val context = applicationContext
        if (context == null) {
            result.error("surface_no_context", "Application context is unavailable", null)
            return
        }
        when (call.method) {
            "configureSurfaces" -> {
                PocketSurfaceBridgeStore.liveSurfaceChannel = surfacesChannel
                result.success(mapOf("configured" to true, "ecosystem" to "android"))
            }
            "disableSurfaces" -> {
                if (PocketSurfaceBridgeStore.liveSurfaceChannel === surfacesChannel) {
                    PocketSurfaceBridgeStore.liveSurfaceChannel = null
                }
                result.success(null)
            }
            "getSurfaceStatus" -> {
                val prefs = context.getSharedPreferences(
                    PocketSurfaceBridgeStore.PREFS_NAME,
                    Context.MODE_PRIVATE,
                )
                val rawPending = prefs.getString(PocketSurfaceBridgeStore.PENDING_ACTIONS_KEY, null)
                val count = try {
                    if (rawPending == null) 0 else JSONArray(rawPending).length()
                } catch (_: Exception) {
                    0
                }
                val notifications = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
                val widgets = AppWidgetManager.getInstance(context)
                result.success(
                    mapOf(
                        "available" to true,
                        "ecosystem" to "android",
                        "appGroupId" to null,
                        "supportsWidgets" to (widgets != null && hostWidgetProviders(context, widgets).isNotEmpty()),
                        "supportsLiveActivities" to (ongoingNotificationUnavailableReason(notifications) == null),
                        "watchPaired" to false,
                        "pendingActionCount" to count,
                    ),
                )
            }
            "publishSnapshot" -> {
                val args = call.arguments as? Map<*, *>
                val snapshotJson = args?.get("snapshotJson") as? String
                if (snapshotJson.isNullOrBlank()) {
                    result.success(mapOf("published" to false, "reloadedWidgets" to false))
                    return
                }
                val prefs = context.getSharedPreferences(
                    PocketSurfaceBridgeStore.PREFS_NAME,
                    Context.MODE_PRIVATE,
                )
                prefs.edit().putString(PocketSurfaceBridgeStore.SNAPSHOT_KEY, snapshotJson).apply()
                val reloaded = reloadHostAppWidgets(context)
                result.success(
                    mapOf(
                        "published" to true,
                        "reloadedWidgets" to reloaded,
                        "pushedWatchContext" to false,
                    ),
                )
            }
            "upsertLiveActivity" -> {
                val args = call.arguments as? Map<*, *> ?: emptyMap<String, Any>()
                val reason = postOngoingNotification(context, args)
                if (reason == null) {
                    result.success(mapOf("active" to true, "activityId" to (args["activityId"] ?: "default")))
                } else {
                    result.success(mapOf("active" to false, "reason" to reason))
                }
            }
            "endLiveActivity" -> {
                val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
                nm?.cancel(LIVE_UPDATE_NOTIFICATION_ID)
                result.success(mapOf("active" to false))
            }
            "drainPendingActions" -> {
                val drained = PocketSurfaceBridgeStore.drainPendingActions(context)
                result.success(mapOf("actions" to drained))
            }
            else -> result.notImplemented()
        }
    }

    private fun hostWidgetProviders(
        context: Context,
        manager: AppWidgetManager,
    ): List<AppWidgetProviderInfo> = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        manager.getInstalledProvidersForPackage(context.packageName, null)
    } else {
        manager.installedProviders.filter { it.provider.packageName == context.packageName }
    }

    private fun reloadHostAppWidgets(context: Context): Boolean {
        val manager = AppWidgetManager.getInstance(context) ?: return false
        var updatedAny = false
        for (info in hostWidgetProviders(context, manager)) {
            val component: ComponentName = info.provider
            val ids = manager.getAppWidgetIds(component)
            if (ids.isNotEmpty()) {
                val updateIntent = Intent(AppWidgetManager.ACTION_APPWIDGET_UPDATE).apply {
                    setComponent(component)
                    putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids)
                }
                context.sendBroadcast(updateIntent)
                updatedAny = true
            }
        }
        return updatedAny
    }

    private fun ongoingNotificationUnavailableReason(notifications: NotificationManager?): String? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || notifications == null) {
            return "ongoing_notifications_unavailable"
        }
        if (!notifications.areNotificationsEnabled()) return "notifications_disabled"
        if (notifications.getNotificationChannel(LIVE_UPDATE_CHANNEL_ID)?.importance == NotificationManager.IMPORTANCE_NONE) {
            return "notification_channel_disabled"
        }
        return null
    }

    private fun postOngoingNotification(context: Context, args: Map<*, *>): String? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return "ongoing_notifications_unavailable"
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            ?: return "ongoing_notifications_unavailable"
        ongoingNotificationUnavailableReason(nm)?.let { return it }
        val channel = NotificationChannel(
            LIVE_UPDATE_CHANNEL_ID,
            "Live Surface Updates",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            setShowBadge(false)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        }
        nm.createNotificationChannel(channel)

        val title = (args["title"] as? String)?.trim().orEmpty()
        if (title.isEmpty()) return "invalid_title"
        val badge = (args["leadingBadge"] as? String)?.trim().orEmpty()
        val metric = (args["trailingMetric"] as? String)?.trim().orEmpty()
        val subtitle = (args["subtitle"] as? String)?.trim().orEmpty()
        val progressRatio = ((args["progress"] as? Number)?.toDouble() ?: 0.0).coerceIn(0.0, 1.0)
        val primaryHref = (args["primaryHref"] as? String)?.trim().orEmpty()
        val primaryLabel = (args["primaryActionLabel"] as? String)?.trim().orEmpty()
        val secondaryHref = (args["secondaryHref"] as? String)?.trim().orEmpty()
        val secondaryLabel = (args["secondaryActionLabel"] as? String)?.trim().orEmpty()

        val displayTitle = listOf(badge, title, metric).filter { it.isNotEmpty() }.joinToString(" · ")
        val builder = Notification.Builder(context, LIVE_UPDATE_CHANNEL_ID)
            .setSmallIcon(context.applicationInfo.icon.takeIf { it != 0 } ?: android.R.drawable.ic_dialog_info)
            .setContentTitle(displayTitle)
            .setContentText(subtitle)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setProgress(1000, (progressRatio * 1000.0).toInt(), false)
            .addExtras(Bundle().apply { putBoolean("android.support.ongoing", true) })

        if (primaryHref.isNotEmpty()) {
            val contentIntent = buildDeepLinkPendingIntent(context, primaryHref, 101)
            if (contentIntent != null) {
                builder.setContentIntent(contentIntent)
                if (primaryLabel.isNotEmpty()) {
                    builder.addAction(
                        Notification.Action.Builder(null, primaryLabel, contentIntent).build(),
                    )
                }
            }
        }
        if (secondaryHref.isNotEmpty() && secondaryLabel.isNotEmpty()) {
            val secIntent = buildDeepLinkPendingIntent(context, secondaryHref, 102)
            if (secIntent != null) {
                builder.addAction(
                    Notification.Action.Builder(null, secondaryLabel, secIntent).build(),
                )
            }
        }
        return try {
            nm.notify(LIVE_UPDATE_NOTIFICATION_ID, builder.build())
            ongoingNotificationUnavailableReason(nm)
        } catch (_: SecurityException) {
            "notifications_disabled"
        }
    }

    private fun buildDeepLinkPendingIntent(
        context: Context,
        href: String,
        requestCode: Int,
    ): PendingIntent? {
        val uri = try {
            Uri.parse(href)
        } catch (_: Exception) {
            return null
        }
        val intent = Intent(Intent.ACTION_VIEW, uri).apply {
            setPackage(context.packageName)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        return PendingIntent.getActivity(context, requestCode, intent, flags)
    }

    private fun configureDeepLinks(rawArguments: Any?, result: MethodChannel.Result) {
        val args = rawArguments as? Map<*, *>
        val enabled = args?.get("enabled") as? Boolean ?: false
        val rawScheme = args?.get("scheme") as? String
        val scheme = rawScheme?.let(::validatedScheme)
        if (!enabled || scheme == null) {
            result.error(
                "platform_invalid_argument",
                "deep links require enabled=true and a custom URL scheme",
                null,
            )
            return
        }
        if (!staticOptInAllows(scheme)) {
            result.error(
                "platform_deep_links_not_enabled",
                "DEEP_LINKS_ENABLED and DEEP_LINK_SCHEMES do not allow this scheme",
                mapOf("scheme" to scheme),
            )
            return
        }
        if (configuredScheme != scheme) {
            initialLink = null
            latestLink = null
            recentUris.clear()
        }
        linksEnabled = true
        configuredScheme = scheme
        attachIntentListener()
        result.success(mapOf("enabled" to true, "scheme" to scheme))
        // Android keeps the launch intent on the Activity. Read it only after
        // both opt-in layers have succeeded; disabled startup never caches it.
        activity?.intent?.data?.let(::receive)
    }

    private fun disableDeepLinks() {
        if (intentListenerAttached) {
            activityBinding?.removeOnNewIntentListener(this)
            intentListenerAttached = false
        }
        preconfigurationCaptureOpen = false
        linksEnabled = false
        configuredScheme = null
        initialLink = null
        latestLink = null
        recentUris.clear()
    }

    private fun receive(uri: Uri) {
        val incomingScheme = uri.scheme?.let(::validatedScheme) ?: return
        if (!staticOptInAllows(incomingScheme)) return
        if (!linksEnabled) {
            if (!preconfigurationCaptureOpen ||
                (configuredScheme != null && configuredScheme != incomingScheme)
            ) return
            configuredScheme = incomingScheme
        } else if (configuredScheme != incomingScheme) {
            return
        }
        val value = uri.toString()
        if (value.isEmpty()) return
        val now = SystemClock.elapsedRealtime()
        if (recentUris.any {
                it.value == value &&
                    now >= it.atMillis &&
                    now - it.atMillis < deepLinkDedupeWindowMillis
            }) return
        recentUris.addLast(RecentUri(value, now))
        while (recentUris.size > maxRecentUris) recentUris.removeFirst()
        if (initialLink == null) initialLink = value
        latestLink = value
        if (linksEnabled) channel?.invokeMethod("onDeepLink", mapOf("uri" to value))
    }

    private fun staticOptInAllows(scheme: String): Boolean {
        val context = applicationContext ?: return false
        val info = try {
            context.packageManager.getApplicationInfo(
                context.packageName,
                PackageManager.GET_META_DATA,
            )
        } catch (_: PackageManager.NameNotFoundException) {
            return false
        }
        val metadata = info.metaData ?: return false
        if (!metadata.getBoolean(ENABLED_KEY, false)) return false
        val schemes = metadata.getString(SCHEMES_KEY)
            ?.split(',')
            ?.mapNotNull { validatedScheme(it) }
            ?: emptyList()
        return schemes.contains(scheme)
    }

    private fun detachActivity() {
        if (intentListenerAttached) {
            activityBinding?.removeOnNewIntentListener(this)
            intentListenerAttached = false
        }
        activityBinding = null
        activity = null
    }

    private fun attachIntentListener() {
        if (!linksEnabled || intentListenerAttached) return
        activityBinding?.addOnNewIntentListener(this)
        intentListenerAttached = activityBinding != null
    }

    private fun validatedScheme(raw: String): String? {
        val scheme = raw
        val forbidden = setOf("http", "https", "file", "data", "javascript", "content", "intent")
        if (scheme.length !in 1..32 || scheme != scheme.lowercase(Locale.US) || forbidden.contains(scheme)) return null
        if (!scheme.matches(Regex("[a-z][a-z0-9+.-]*"))) return null
        return scheme
    }
}
