import Flutter
import Foundation
import UIKit
#if canImport(WidgetKit)
import WidgetKit
#endif
#if canImport(ActivityKit) && os(iOS)
import ActivityKit
#endif
#if canImport(WatchConnectivity) && os(iOS)
import WatchConnectivity
#endif

/// Shared ActivityKit attribute model matching scaffolded `PocketWidgets` extension targets.
#if canImport(ActivityKit) && os(iOS)
@available(iOS 16.2, *)
public struct PocketSharedLiveActivityAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    public var leadingBadge: String
    public var trailingMetric: String
    public var title: String
    public var subtitle: String
    public var progress: Double
    public var primaryActionLabel: String
    public var primaryHref: String
    public var secondaryActionLabel: String?
    public var secondaryHref: String?

    public init(
      leadingBadge: String,
      trailingMetric: String,
      title: String,
      subtitle: String,
      progress: Double,
      primaryActionLabel: String,
      primaryHref: String,
      secondaryActionLabel: String? = nil,
      secondaryHref: String? = nil
    ) {
      self.leadingBadge = leadingBadge
      self.trailingMetric = trailingMetric
      self.title = title
      self.subtitle = subtitle
      self.progress = progress
      self.primaryActionLabel = primaryActionLabel
      self.primaryHref = primaryHref
      self.secondaryActionLabel = secondaryActionLabel
      self.secondaryHref = secondaryHref
    }
  }

  public var activityKey: String

  public init(activityKey: String) {
    self.activityKey = activityKey
  }
}
#endif

/// Native half of the opt-in links and ecosystem surfaces provider.
///
/// This plugin does not register a URL scheme or edit the consumer's
/// Info.plist. The trusted consumer owns its URL declaration and forwards
/// cold/warm SceneDelegate URL contexts to `handleIncomingURL`.
public final class PocketPlatformPlugin: NSObject, FlutterPlugin {
  private static var shared: PocketPlatformPlugin?
  // SceneDelegate can deliver connectionOptions before Flutter has finished
  // registering plugins. Keep at most the old manager's initial/latest pair
  // until the plugin instance is attached; static metadata is checked before
  // anything is retained, so installing the package alone still has no URL
  // collection side effect.
  private static var preconfigurationURLs: [String] = []

  private var channel: FlutterMethodChannel?
  private var surfaceBridge: PocketSurfaceNativeBridge?
  private var linksEnabled = false
  private var configuredScheme: String?
  private var initialLink: String?
  private var latestLink: String?
  private struct RecentURL {
    let value: String
    let atUptime: TimeInterval
  }

  private var recentURLs: [RecentURL] = []
  private let deepLinkDedupeWindow: TimeInterval = 0.25
  private let maxRecentURLs = 32
  // A trusted static opt-in may deliver a cold SceneDelegate URL before the
  // Dart isolate has activated the provider. This one-shot preconfiguration
  // window is closed by disable/dispose; without static metadata receive()
  // drops the URL and never creates a cache.
  private var preconfigurationCaptureOpen = true

  public static func register(with registrar: FlutterPluginRegistrar) {
    let instance = PocketPlatformPlugin()
    let channel = FlutterMethodChannel(
      name: "com.pocketnexus.host/platform",
      binaryMessenger: registrar.messenger()
    )
    instance.channel = channel

    let surfaceChannel = FlutterMethodChannel(
      name: "com.pocketnexus.host/surfaces",
      binaryMessenger: registrar.messenger()
    )
    let surfaceBridge = PocketSurfaceNativeBridge(channel: surfaceChannel)
    instance.surfaceBridge = surfaceBridge
    surfaceChannel.setMethodCallHandler { [weak surfaceBridge] call, result in
      guard let surfaceBridge else {
        result(FlutterMethodNotImplemented)
        return
      }
      surfaceBridge.handle(call, result: result)
    }

    PocketPlatformPlugin.shared = instance
    let pendingURLs = PocketPlatformPlugin.preconfigurationURLs
    PocketPlatformPlugin.preconfigurationURLs.removeAll(keepingCapacity: false)
    pendingURLs.forEach { value in
      if let url = URL(string: value) {
        instance.receive(url)
      }
    }
    registrar.addMethodCallDelegate(instance, channel: channel)
  }

  /// Forward a URL from the consuming app's SceneDelegate.
  ///
  /// The URL is dropped unless the consumer's static metadata allows the
  /// scheme. Before Dart activation it is only retained as bounded native
  /// cold-start state; it is never exposed to a guest until Dart configures
  /// the same scheme.
  public static func handleIncomingURL(_ url: URL) {
    if let plugin = shared {
      plugin.receive(url)
      return
    }
    guard let scheme = url.scheme.flatMap(validatedScheme),
          staticOptInAllows(scheme: scheme)
    else {
      return
    }
    let value = url.absoluteString
    guard !value.isEmpty else { return }
    if preconfigurationURLs.count == 2 {
      preconfigurationURLs.removeFirst()
    }
    preconfigurationURLs.append(value)
  }

  /// Alias used by consumers whose AppDelegate names the callback OpenURL.
  public static func handleOpenURL(_ url: URL) {
    handleIncomingURL(url)
  }

  public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    switch call.method {
    case "configureDeepLinks":
      configureDeepLinks(call.arguments, result: result)
    case "getInitialLink":
      result(["uri": (initialLink as Any?) ?? NSNull()])
    case "getLatestLink":
      result(["uri": (latestLink as Any?) ?? NSNull()])
    case "disableDeepLinks":
      disableDeepLinks()
      result(["disabled": true])
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  public func detachFromEngine(for registrar: FlutterPluginRegistrar) {
    disableDeepLinks()
    surfaceBridge?.dispose()
    surfaceBridge = nil
    channel = nil
    if PocketPlatformPlugin.shared === self {
      PocketPlatformPlugin.shared = nil
    }
  }

  private func configureDeepLinks(_ rawArguments: Any?, result: @escaping FlutterResult) {
    guard let args = rawArguments as? [String: Any],
          let enabled = args["enabled"] as? Bool,
          enabled,
          let rawScheme = args["scheme"] as? String,
          let scheme = Self.validatedScheme(rawScheme)
    else {
      result(FlutterError(
        code: "platform_invalid_argument",
        message: "deep links require enabled=true and a custom URL scheme",
        details: nil
      ))
      return
    }

    guard Self.staticOptInAllows(scheme: scheme) else {
      result(FlutterError(
        code: "platform_deep_links_not_enabled",
        message: "PocketDeepLinksEnabled and PocketDeepLinkSchemes do not allow this scheme",
        details: ["scheme": scheme]
      ))
      return
    }

    if configuredScheme != scheme {
      initialLink = nil
      latestLink = nil
      recentURLs.removeAll(keepingCapacity: true)
    }
    linksEnabled = true
    configuredScheme = scheme
    result(["enabled": true, "scheme": scheme])
  }

  private func disableDeepLinks() {
    preconfigurationCaptureOpen = false
    linksEnabled = false
    configuredScheme = nil
    initialLink = nil
    latestLink = nil
    recentURLs.removeAll(keepingCapacity: false)
  }

  private func receive(_ url: URL) {
    guard let incomingScheme = url.scheme.flatMap(Self.validatedScheme),
          Self.staticOptInAllows(scheme: incomingScheme)
    else {
      return
    }
    if !linksEnabled {
      guard preconfigurationCaptureOpen,
            configuredScheme == nil || configuredScheme == incomingScheme
      else { return }
      configuredScheme = incomingScheme
    } else if configuredScheme != incomingScheme {
      return
    }
    let uri = url.absoluteString
    guard !uri.isEmpty else { return }
    let now = ProcessInfo.processInfo.systemUptime
    if recentURLs.contains(where: {
      $0.value == uri && now >= $0.atUptime && now - $0.atUptime < deepLinkDedupeWindow
    }) {
      return
    }
    recentURLs.append(RecentURL(value: uri, atUptime: now))
    while recentURLs.count > maxRecentURLs {
      recentURLs.removeFirst()
    }
    if initialLink == nil {
      initialLink = uri
    }
    latestLink = uri
    if linksEnabled {
      channel?.invokeMethod("onDeepLink", arguments: ["uri": uri])
    }
  }

  private static func staticOptInAllows(scheme: String) -> Bool {
    let enabled = Bundle.main.object(forInfoDictionaryKey: "PocketDeepLinksEnabled") as? Bool ?? false
    guard enabled else { return false }
    let raw = Bundle.main.object(forInfoDictionaryKey: "PocketDeepLinkSchemes")
    let schemes: [String]
    if let values = raw as? [String] {
      schemes = values
    } else if let value = raw as? String {
      schemes = [value]
    } else {
      schemes = []
    }
    return schemes.contains { validatedScheme($0) == scheme }
  }

  private static func validatedScheme(_ raw: String) -> String? {
    let scheme = raw
    let forbidden = Set(["http", "https", "file", "data", "javascript", "content", "intent"])
    guard scheme.count >= 1,
          scheme.count <= 32,
          scheme == scheme.lowercased(),
          !forbidden.contains(scheme)
    else { return nil }
    let scalars = Array(scheme.unicodeScalars)
    guard let first = scalars.first, first.value >= 0x61, first.value <= 0x7a else {
      return nil
    }
    guard scalars.dropFirst().allSatisfy({ scalar in
      (scalar.value >= 0x61 && scalar.value <= 0x7a) ||
        (scalar.value >= 0x30 && scalar.value <= 0x39) ||
        scalar.value == 0x2b || scalar.value == 0x2e || scalar.value == 0x2d
    }) else {
      return nil
    }
    return scheme
  }
}

/// Native iOS host <-> WidgetKit / ActivityKit / WatchConnectivity bridge.
final class PocketSurfaceNativeBridge: NSObject {
  private static let snapshotDefaultsKey = "dev.pocketjs.surfaces.snapshot.v1"
  private static let pendingActionsKey = "dev.pocketjs.surfaces.pending_actions.v1"
  private static let snapshotFileName = "pocket_surface_snapshot.json"

  private var channel: FlutterMethodChannel?
  private var configuredAppGroupId: String?
  private var activeObserver: NSObjectProtocol?
  private var deliveringAction = false
  private var pendingDrains: [(String?, FlutterResult)] = []

  init(channel: FlutterMethodChannel) {
    self.channel = channel
    super.init()
  }

  private func enableActionForwarding() {
    guard activeObserver == nil else { return }
    activeObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.didBecomeActiveNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.deliverQueuedActions()
    }
    activateWatchSessionIfSupported()
  }

  private func disableActionForwarding() {
    if let observer = activeObserver {
      NotificationCenter.default.removeObserver(observer)
      activeObserver = nil
    }
    #if canImport(WatchConnectivity) && os(iOS)
    if WCSession.isSupported(), WCSession.default.delegate === self {
      WCSession.default.delegate = nil
    }
    #endif
  }

  func dispose() {
    disableActionForwarding()
    channel?.setMethodCallHandler(nil)
    channel = nil
    let drains = pendingDrains
    pendingDrains.removeAll()
    for (_, result) in drains {
      result(FlutterMethodNotImplemented)
    }
  }

  func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    switch call.method {
    case "configureSurfaces":
      let args = call.arguments as? [String: Any]
      configuredAppGroupId = args?["appGroupId"] as? String
      enableActionForwarding()
      result(["configured": true, "appGroupId": (resolvedAppGroupId() as Any?) ?? NSNull()])

    case "disableSurfaces":
      disableActionForwarding()
      result(nil)

    case "getSurfaceStatus":
      let args = call.arguments as? [String: Any]
      let group = (args?["appGroupId"] as? String) ?? resolvedAppGroupId()
      let defaults = sharedDefaults(appGroupId: group)
      var supportsWidgets = false
      #if canImport(WidgetKit)
      if #available(iOS 14.0, *), let group {
        supportsWidgets = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) != nil
      }
      #endif
      let pending = (defaults.array(forKey: Self.pendingActionsKey) as? [[String: Any]])?.count ?? 0
      var supportsLive = false
      #if canImport(ActivityKit) && os(iOS)
      if #available(iOS 16.2, *) {
        supportsLive = Bundle.main.object(forInfoDictionaryKey: "NSSupportsLiveActivities") as? Bool == true
          && ActivityAuthorizationInfo().areActivitiesEnabled
      }
      #endif
      var watchPaired = false
      #if canImport(WatchConnectivity) && os(iOS)
      if WCSession.isSupported() {
        watchPaired = WCSession.default.isPaired
      }
      #endif
      result([
        "available": true,
        "ecosystem": "apple",
        "appGroupId": (group as Any?) ?? NSNull(),
        "supportsWidgets": supportsWidgets,
        "supportsLiveActivities": supportsLive,
        "watchPaired": watchPaired,
        "pendingActionCount": pending,
      ])

    case "publishSnapshot":
      publishSnapshot(call.arguments, result: result)

    case "upsertLiveActivity":
      upsertLiveActivity(call.arguments, result: result)

    case "endLiveActivity":
      endLiveActivity(call.arguments, result: result)

    case "drainPendingActions":
      let args = call.arguments as? [String: Any]
      let group = (args?["appGroupId"] as? String) ?? resolvedAppGroupId()
      if deliveringAction {
        pendingDrains.append((group, result))
      } else {
        result(["actions": drainActions(appGroupId: group)])
      }

    default:
      result(FlutterMethodNotImplemented)
    }
  }

  private func resolvedAppGroupId() -> String? {
    if let configured = configuredAppGroupId, !configured.isEmpty {
      return configured
    }
    if let plistGroup = Bundle.main.object(forInfoDictionaryKey: "PocketAppGroupIdentifier") as? String,
       !plistGroup.isEmpty {
      return plistGroup
    }
    return nil
  }

  private func sharedDefaults(appGroupId: String?) -> UserDefaults {
    if let group = appGroupId, !group.isEmpty, let suite = UserDefaults(suiteName: group) {
      return suite
    }
    return UserDefaults.standard
  }

  private func publishSnapshot(_ rawArgs: Any?, result: @escaping FlutterResult) {
    guard let args = rawArgs as? [String: Any],
          let snapshotJson = args["snapshotJson"] as? String
    else {
      result(["published": false, "reloadedWidgets": false, "reason": "missing_snapshot_json"])
      return
    }
    guard let group = (args["appGroupId"] as? String) ?? resolvedAppGroupId(),
          let containerURL = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group),
          let defaults = UserDefaults(suiteName: group)
    else {
      result(["published": false, "reloadedWidgets": false, "reason": "app_group_unavailable"])
      return
    }
    do {
      let fileURL = containerURL.appendingPathComponent(Self.snapshotFileName)
      try Data(snapshotJson.utf8).write(to: fileURL, options: .atomic)
    } catch {
      result(["published": false, "reloadedWidgets": false, "reason": "snapshot_write_failed"])
      return
    }
    defaults.set(snapshotJson, forKey: Self.snapshotDefaultsKey)
    if let snap = args["snapshot"] as? [String: Any],
       let profileId = snap["profileId"] as? String,
       !profileId.isEmpty {
      defaults.set(snapshotJson, forKey: "dev.pocketjs.surfaces.snapshot.\(profileId)")
    }

    var reloaded = false
    #if canImport(WidgetKit)
    if #available(iOS 14.0, *) {
      WidgetCenter.shared.reloadAllTimelines()
      reloaded = true
    }
    #endif

    var pushedWatch = false
    #if canImport(WatchConnectivity) && os(iOS)
    if WCSession.isSupported() && WCSession.default.activationState == .activated && WCSession.default.isPaired {
      do {
        try WCSession.default.updateApplicationContext(["snapshotJson": snapshotJson])
        pushedWatch = true
      } catch {
        pushedWatch = false
      }
    }
    #endif

    result([
      "published": true,
      "reloadedWidgets": reloaded,
      "pushedWatchContext": pushedWatch,
    ])
  }

  private func upsertLiveActivity(_ rawArgs: Any?, result: @escaping FlutterResult) {
    #if canImport(ActivityKit) && os(iOS)
    if #available(iOS 16.2, *) {
      guard Bundle.main.object(forInfoDictionaryKey: "NSSupportsLiveActivities") as? Bool == true else {
        result(["active": false, "reason": "activities_not_configured"])
        return
      }
      guard ActivityAuthorizationInfo().areActivitiesEnabled else {
        result(["active": false, "reason": "activities_disabled"])
        return
      }
      let args = (rawArgs as? [String: Any]) ?? [:]
      let key = (args["activityId"] as? String) ?? "default"
      let state = PocketSharedLiveActivityAttributes.ContentState(
        leadingBadge: (args["leadingBadge"] as? String) ?? "LIVE",
        trailingMetric: (args["trailingMetric"] as? String) ?? "",
        title: (args["title"] as? String) ?? "",
        subtitle: (args["subtitle"] as? String) ?? "",
        progress: (args["progress"] as? Double) ?? 0.0,
        primaryActionLabel: (args["primaryActionLabel"] as? String) ?? "Open",
        primaryHref: (args["primaryHref"] as? String) ?? "",
        secondaryActionLabel: args["secondaryActionLabel"] as? String,
        secondaryHref: args["secondaryHref"] as? String
      )

      for activity in Activity<PocketSharedLiveActivityAttributes>.activities
        where activity.attributes.activityKey == key || activity.id == key {
        Task { @MainActor in
          await activity.update(ActivityContent(state: state, staleDate: nil))
          result(["active": true, "activityId": activity.id])
        }
        return
      }

      do {
        let attributes = PocketSharedLiveActivityAttributes(activityKey: key)
        let created = try Activity.request(
          attributes: attributes,
          content: ActivityContent(state: state, staleDate: nil),
          pushType: nil
        )
        result(["active": true, "activityId": created.id])
      } catch {
        result(["active": false, "reason": error.localizedDescription])
      }
      return
    }
    #endif
    result(["active": false, "reason": "activitykit_unavailable"])
  }

  private func endLiveActivity(_ rawArgs: Any?, result: @escaping FlutterResult) {
    #if canImport(ActivityKit) && os(iOS)
    if #available(iOS 16.2, *) {
      let args = (rawArgs as? [String: Any]) ?? [:]
      let targetKey = args["activityId"] as? String
      for activity in Activity<PocketSharedLiveActivityAttributes>.activities {
        if targetKey == nil || activity.attributes.activityKey == targetKey || activity.id == targetKey {
          Task {
            await activity.end(nil, dismissalPolicy: .immediate)
          }
        }
      }
    }
    #endif
    result(["active": false])
  }

  private func drainActions(appGroupId: String?) -> [[String: Any]] {
    let defaults = sharedDefaults(appGroupId: appGroupId)
    let queued = (defaults.array(forKey: Self.pendingActionsKey) as? [[String: Any]]) ?? []
    if !queued.isEmpty {
      defaults.removeObject(forKey: Self.pendingActionsKey)
    }
    return queued
  }

  private func deliverQueuedActions() {
    guard !deliveringAction, activeObserver != nil, let channel else { return }
    let defaults = sharedDefaults(appGroupId: resolvedAppGroupId())
    guard let item = (defaults.array(forKey: Self.pendingActionsKey) as? [[String: Any]])?.first else {
      return
    }
    deliveringAction = true
    channel.invokeMethod("onWidgetAction", arguments: item) { [weak self] reply in
      guard let self else { return }
      let delivered = (reply as? Bool) == true
      if delivered {
        var queue = (defaults.array(forKey: Self.pendingActionsKey) as? [[String: Any]]) ?? []
        if let index = queue.firstIndex(where: { NSDictionary(dictionary: $0).isEqual(to: item) }) {
          queue.remove(at: index)
          defaults.set(queue, forKey: Self.pendingActionsKey)
        }
        if let href = item["href"] as? String, let url = URL(string: href) {
          PocketPlatformPlugin.handleIncomingURL(url)
        }
      }
      deliveringAction = false
      let drains = pendingDrains
      pendingDrains.removeAll()
      for (group, result) in drains {
        result(["actions": drainActions(appGroupId: group)])
      }
      if delivered {
        deliverQueuedActions()
      }
    }
  }

  private func activateWatchSessionIfSupported() {
    #if canImport(WatchConnectivity) && os(iOS)
    if WCSession.isSupported() {
      let session = WCSession.default
      if session.delegate == nil {
        session.delegate = self
      }
      if session.activationState == .notActivated {
        session.activate()
      }
    }
    #endif
  }
}

#if canImport(WatchConnectivity) && os(iOS)
extension PocketSurfaceNativeBridge: WCSessionDelegate {
  func session(
    _ session: WCSession,
    activationDidCompleteWith activationState: WCSessionActivationState,
    error: Error?
  ) {}

  func sessionDidBecomeInactive(_ session: WCSession) {}

  func sessionDidDeactivate(_ session: WCSession) {
    session.activate()
  }

  func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
    forwardWatchAction(userInfo)
  }

  func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
    forwardWatchAction(message)
  }

  private func forwardWatchAction(_ payload: [String: Any]) {
    guard let id = payload["id"] as? String,
          let href = payload["href"] as? String,
          !id.isEmpty,
          !href.isEmpty
    else { return }
    let event: [String: Any] = [
      "id": id,
      "href": href,
      "source": "apple-watch",
      "timestampMs": Int(Date().timeIntervalSince1970 * 1000),
    ]
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      let defaults = sharedDefaults(appGroupId: resolvedAppGroupId())
      var queue = (defaults.array(forKey: Self.pendingActionsKey) as? [[String: Any]]) ?? []
      queue.append(event)
      defaults.set(Array(queue.suffix(32)), forKey: Self.pendingActionsKey)
      deliverQueuedActions()
    }
  }
}
#endif
