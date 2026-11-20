const $ = (id) => document.getElementById(id);

const POLL_DELAY_MS = 1200;
const MAX_BUILD_POLL_ATTEMPTS = 300;
const MAX_DEPLOY_POLL_ATTEMPTS = 300;
const MAX_WECHAT_POLL_ATTEMPTS = 300;
const WECHAT_STATES = new Set(["idle", "building", "running", "error", "stopped"]);
const PROJECT_CONFIG_FIELDS = [["config-name", "name"], ["config-app-id", "appId"], ["config-version", "version"]];
const PROJECT_CONFIG_INPUTS = PROJECT_CONFIG_FIELDS.map(([id]) => id);
const VIEWPORTS = {
  // The mobile dimensions are filled from the runner's device profile before
  // projects are loaded. Keep no second device definition in the editor.
  mobile: { width: 0, height: 0, label: "Mobile", safeArea: null },
  tablet: { width: 768, height: 1023, label: "Tablet", safeArea: null },
  desktop: { width: 1023, height: 768, label: "Desktop", safeArea: null },
};

const projectsEl = $("projects");
const projectSwitcher = $("project-switcher");
const sourceEl = $("source");
const noticeEl = $("notice");
const logEl = $("log");
const createDialog = $("create-dialog");
const previewFrame = $("preview-frame");
const previewStage = $("preview-stage");
const previewStageWrap = $("preview-stage-wrap") || document.querySelector(".preview-stage-wrap");
const previewSurfaces = $("preview-surfaces");
const previewPhoneShell = $("preview-phone-shell");
const wechatPreviewPane = $("wechat-preview-pane");
const wechatPreviewShell = $("wechat-preview-shell");
const wechatPreviewFrame = $("wechat-preview-frame");
const wechatPreviewEmpty = $("wechat-preview-empty");

let projects = [];
let currentId = null;
let projectSelectionStorageKey = "pocket.studio.selected-project";
let currentStatus = null;
let currentFile = "app.tsx";
let projectFiles = [];
let buildPollTimer = null;
let deployPollTimer = null;
let startingBuild = false;
let dirty = false;
let saving = false;
let publishing = false;
let csrfToken = "";
let previewPath = "";
let previewReady = false;
let previewHasFrame = false;
let previewHostNoticeProject = "";
let previewStarted = false;
let previewRevision = null;
let previewGeneration = null;
let previewRegionsEnabled = false;
let previewGpuAvailable = false;
let previewGpuActive = false;
let previewGpuRequested = false;
let previewLoadSequence = 0;
let captureSequence = 0;
const captureWaiters = new Map();
const PREVIEW_HEIGHT_STORAGE_KEY = "pocket.editor.previewPaneHeight";
const PREVIEW_BEZEL_STORAGE_KEY = "pocket.editor.previewShowBezel";
const PREVIEW_GPU_STORAGE_PREFIX = "pocket.editor.directWebPreview.";
const NOBLE_BLUETOOTH_STORAGE_KEY = "pocket.editor.webBluetooth";
let nobleBluetoothSupported = false;
let localBluetoothAvailable = false;
let bluetoothProvider = "local";
let webBluetoothEnabled = false;
try { webBluetoothEnabled = localStorage.getItem(NOBLE_BLUETOOTH_STORAGE_KEY) === "1"; } catch {}
let previewDeviceProfile = null;
let previewDevicePromise = null;
let allSurfaceProfiles = [];
const surfaceProfilesById = new Map();
let currentSurfaceRenderMode = "";
let currentProjectConfig = null;
let ecosystemApplying = false;

const DEFAULT_ECOSYSTEM_MODULES = [
  {
    id: "apple-devices",
    ecosystem: "apple",
    label: "Apple 全家桶多端设备",
    description: "iPhone / iPad Pro & 分屏 / macOS 窗口与菜单栏 / Apple TV / Vision Pro / CarPlay",
    profileIds: ["iphone-16-pro", "iphone-se", "ipad-pro", "ipad-split", "macos-window", "macos-menubar", "apple-tv", "vision-pro", "carplay"],
  },
  {
    id: "apple-today",
    ecosystem: "apple",
    label: "iOS / iPadOS Today 与主屏小组件",
    description: "WidgetKit Small / Medium / Large / iPad XL",
    profileIds: ["ios-widget-small", "ios-widget-medium", "ios-widget-large", "ipad-widget-xl"],
  },
  {
    id: "apple-lock",
    ecosystem: "apple",
    label: "iOS 锁屏小组件",
    description: "Circular / Rectangular / Inline 锁屏配件",
    profileIds: ["ios-lock-circular", "ios-lock-rectangular", "ios-lock-inline"],
  },
  {
    id: "apple-live-activity",
    ecosystem: "apple",
    label: "iOS 灵动岛与实时活动",
    description: "Dynamic Island Compact / Minimal / Expanded & Live Activity",
    profileIds: ["ios-island-compact", "ios-island-minimal", "ios-live-activity-expanded", "ios-lock-live-activity"],
  },
  {
    id: "apple-watch",
    ecosystem: "apple",
    label: "Apple Watch 应用、叠放与表盘",
    description: "watchOS 45mm / Smart Stack / Corner Complication",
    profileIds: ["apple-watch-45mm", "watchos-smart-stack", "watchos-complication-corner"],
  },
  {
    id: "apple-clip",
    ecosystem: "apple",
    label: "iOS App Clip 轻应用卡片",
    description: "免安装即扫即用 App Clip 宿主卡片",
    profileIds: ["ios-app-clip"],
  },
  {
    id: "android-devices",
    ecosystem: "android",
    label: "Android 全家桶多端设备",
    description: "Pixel / 折叠屏外屏与展开双屏 / 平板 / TV / Auto",
    profileIds: ["pixel-9", "android-fold-cover", "android-fold-open", "android-tablet", "android-tv", "android-auto"],
  },
  {
    id: "android-widgets",
    ecosystem: "android",
    label: "Android 桌面微件 AppWidget / Glance",
    description: "Material You 2×2 / 4×2 / 4×4 桌面微件",
    profileIds: ["android-widget-small", "android-widget-medium", "android-widget-large"],
  },
  {
    id: "android-live",
    ecosystem: "android",
    label: "Android 速览与 Live Update",
    description: "At-a-Glance 速览条与 Android 16 实时胶囊",
    profileIds: ["android-at-a-glance", "android-live-update"],
  },
  {
    id: "android-wear",
    ecosystem: "android",
    label: "Wear OS 圆表应用与磁贴 Tile",
    description: "圆表安全区适配、Always-On 与快速磁贴",
    profileIds: ["wear-os-round", "wear-os-tile"],
  },
  {
    id: "android-instant",
    ecosystem: "android",
    label: "Android Instant App 免安装体验",
    description: "Google Play Instant 免安装深链直达",
    profileIds: ["android-instant-app"],
  },
];
let ecosystemModuleCatalog = DEFAULT_ECOSYSTEM_MODULES;
let latestWidgetSnapshot = null;
let devices = [];
let activeDeploy = null;
let startingDeploy = false;
let wechatState = { state: "idle", url: "", error: "", logs: [] };
let wechatPollTimer = null;
let wechatGeneration = 0;
let startingWechat = false;
let stoppingWechat = false;
let resourceInventory = null;
let resourcePackageId = "";
let resourceDraft = new Map();
let resourcesDirty = false;
let resourcesLoading = false;
let resourcesSaving = false;
let resourcesGeneration = 0;
let versionSnapshot = null;
let versionsLoading = false;
let versionsGeneration = 0;
let cosSnapshot = null;
let cosBusy = false;
let cosSettingsOpen = false;
let cosFormProjectId = null;
let cfSnapshot = null;
let cfBusy = false;
let cfSettingsOpen = false;
let cfFormProjectId = null;
let cfTargetDrafts = [];
let cfMatrixDirty = false;
let packagesSnapshot = null;
let packagesBusy = false;
let packagesCategory = "all";
let packagesQuery = "";
let publishTargets = null;
let publishTargetsLoading = false;
let publishTargetsError = "";
let publishTargetsGeneration = 0;
let publishTargetChannel = "test";
let publishTargetContext = null;
let studioUpgradeState = null;
let studioUpgradePollTimer = null;
let studioUpgradePeriodicTimer = null;
let studioUpgradePendingReloadVersion = null;
let studioUpgradeDeferredAutoApply = false;
const STUDIO_UPGRADE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
let removingProjectId = null;

function storedPreviewPaneHeight() {
  try {
    const value = Number(localStorage.getItem(PREVIEW_HEIGHT_STORAGE_KEY));
    return Number.isFinite(value) && value >= 240 && value <= 1200 ? value : null;
  } catch {
    return null;
  }
}

let previewPaneHeight = storedPreviewPaneHeight();

function storedPreviewBezel() {
  try {
    return localStorage.getItem(PREVIEW_BEZEL_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

let previewBezelEnabled = storedPreviewBezel();

function normalizeError(error) {
  if (error instanceof Error) return error;
  return new Error(typeof error === "string" ? error : JSON.stringify(error));
}

function localizedMessage(error) {
  const message = normalizeError(error).message;
  const replacements = [
    ["Preview device profile is unavailable.", "预览设备配置不可用。"],
    ["Preview device profile is missing safeArea.", "预览设备配置缺少安全区信息。"],
    ["Preview device profile is missing shell geometry.", "预览设备配置缺少设备外壳尺寸。"],
    ["Preview device profile has inconsistent safeArea.bottom.", "预览设备配置的底部安全区不一致。"],
    ["Preview capture must be a PNG, JPEG, or WebP image.", "预览截图必须是 PNG、JPEG 或 WebP 图片。"],
    ["Refresh the preview before capturing it.", "请先刷新预览，再截取截图。"],
    ["The preview did not return a screenshot. Refresh it and try again.", "预览没有返回截图，请刷新后重试。"],
    ["Clipboard access is unavailable in this browser.", "此浏览器不支持剪贴板访问。"],
    ["No project selected.", "尚未选择项目。"],
    ["No diagnostics yet.", "暂无诊断信息。"],
    ["The native preview reported an error.", "原生预览报告了错误。"],
    ["The project preview could not be loaded.", "项目预览无法加载。"],
    ["WeChat validation timed out.", "微信验证超时。"],
    ["Resource inventory is unavailable.", "资源清单不可用。"],
    ["Editor backend is outdated. Restart the Editor server and reload this page.", "编辑器后端版本过旧，请重启编辑器服务并刷新页面。"],
  ];
  for (const [source, target] of replacements) if (message === source) return target;
  return message;
}

async function api(path, options = {}) {
  const isForm = typeof FormData !== "undefined" && options.body instanceof FormData;
  const headers = {
    ...(options.body && !isForm ? { "content-type": "application/json" } : {}),
    "x-pocket-editor": "1",
    ...(csrfToken ? { "x-pocket-csrf": csrfToken } : {}),
    ...(options.headers || {}),
  };
  const response = await fetch(path, { ...options, headers });
  const type = response.headers.get("content-type") || "";
  let value;
  try {
    value = type.includes("application/json") ? await response.json() : await response.text();
  } catch {
    value = "";
  }
  if (!response.ok) {
    const message = value && typeof value === "object" ? value.error : value;
    const error = new Error(message || `${response.status} ${response.statusText}`);
    error.status = response.status;
    error.payload = value;
    throw error;
  }
  return value;
}

function requiredProfileNumber(value, field, { min = 0, integer = false } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || (integer && !Number.isInteger(parsed))) {
    throw new Error(`Preview device profile has an invalid ${field}.`);
  }
  return parsed;
}

function normalizePreviewDeviceProfile(payload) {
  const profile = payload && typeof payload === "object" && payload.device && typeof payload.device === "object"
    ? payload.device
    : payload;
  if (!profile || typeof profile !== "object") throw new Error("Preview device profile is unavailable.");
  const safe = profile.safeArea;
  const shell = profile.shell;
  if (!safe || typeof safe !== "object") throw new Error("Preview device profile is missing safeArea.");
  if (!shell || typeof shell !== "object") throw new Error("Preview device profile is missing shell geometry.");
  const normalized = {
    ...profile,
    model: typeof profile.model === "string" && profile.model ? profile.model : "Mobile",
    screenWidth: requiredProfileNumber(profile.screenWidth, "screenWidth", { min: 1, integer: true }),
    screenHeight: requiredProfileNumber(profile.screenHeight, "screenHeight", { min: 1, integer: true }),
    pixelRatio: requiredProfileNumber(profile.pixelRatio, "pixelRatio", { min: 1 }),
    statusBarHeight: requiredProfileNumber(profile.statusBarHeight, "statusBarHeight", { min: 0, integer: true }),
    safeAreaBottom: requiredProfileNumber(profile.safeAreaBottom, "safeAreaBottom", { min: 0, integer: true }),
    safeArea: {
      top: requiredProfileNumber(safe.top, "safeArea.top", { min: 0, integer: true }),
      right: requiredProfileNumber(safe.right, "safeArea.right", { min: 0, integer: true }),
      bottom: requiredProfileNumber(safe.bottom, "safeArea.bottom", { min: 0, integer: true }),
      left: requiredProfileNumber(safe.left, "safeArea.left", { min: 0, integer: true }),
    },
    shell: {
      bezel: requiredProfileNumber(shell.bezel, "shell.bezel", { min: 0 }),
      borderRadius: requiredProfileNumber(shell.borderRadius, "shell.borderRadius", { min: 0 }),
      notchWidth: requiredProfileNumber(shell.notchWidth, "shell.notchWidth", { min: 0 }),
      notchHeight: requiredProfileNumber(shell.notchHeight, "shell.notchHeight", { min: 0 }),
      homeIndicatorWidth: requiredProfileNumber(shell.homeIndicatorWidth, "shell.homeIndicatorWidth", { min: 0 }),
      homeIndicatorHeight: requiredProfileNumber(shell.homeIndicatorHeight, "shell.homeIndicatorHeight", { min: 0 }),
      homeIndicatorBottom: requiredProfileNumber(shell.homeIndicatorBottom, "shell.homeIndicatorBottom", { min: 0 }),
    },
  };
  if (normalized.safeArea.bottom !== normalized.safeAreaBottom) {
    throw new Error("Preview device profile has inconsistent safeArea.bottom.");
  }
  return normalized;
}

function applyPreviewDeviceProfile(profile) {
  previewDeviceProfile = profile;
  VIEWPORTS.mobile = {
    ...VIEWPORTS.mobile,
    width: profile.screenWidth,
    height: profile.screenHeight,
    label: profile.model,
    safeArea: { ...profile.safeArea },
  };
  const mobileOption = $("viewport-picker")?.querySelector('option[value="mobile"]');
  if (mobileOption) mobileOption.textContent = `${profile.model} · ${profile.screenWidth} × ${profile.screenHeight}`;
  if (previewStage) {
    previewStage.style.setProperty("--preview-phone-width", `${profile.screenWidth}px`);
    previewStage.style.setProperty("--preview-phone-height", `${profile.screenHeight}px`);
    previewStage.style.setProperty("--preview-phone-radius", `${profile.shell.borderRadius}px`);
    previewStage.style.setProperty("--preview-phone-bezel", `${profile.shell.bezel}px`);
    previewStage.style.setProperty("--preview-phone-notch-width", `${profile.shell.notchWidth}px`);
    previewStage.style.setProperty("--preview-phone-notch-height", `${profile.shell.notchHeight}px`);
    previewStage.style.setProperty("--preview-phone-statusbar-height", `${profile.statusBarHeight}px`);
    previewStage.style.setProperty("--preview-phone-home-width", `${profile.shell.homeIndicatorWidth}px`);
    previewStage.style.setProperty("--preview-phone-home-height", `${profile.shell.homeIndicatorHeight}px`);
    previewStage.style.setProperty("--preview-phone-home-bottom", `${profile.shell.homeIndicatorBottom}px`);
  }
  if (wechatPreviewFrame) wechatPreviewFrame.style.setProperty("--wechat-device-radius", `${profile.shell.borderRadius}px`);
  setText("preview-device-label", `${profile.model} · ${profile.screenWidth} × ${profile.screenHeight}`);
  setText("wechat-device-label", `${profile.model} · ${profile.screenWidth} × ${profile.screenHeight}`);
  updatePreviewBezelPresentation();
  layoutPreviewFrame();
}

const SURFACE_GROUP_LABELS = {
  "apple-device": "Apple 全家桶设备",
  "apple-widget": "Apple 小组件 · 锁屏 · 灵动岛 · Watch",
  "android-device": "Android 全家桶设备",
  "android-widget": "Android 微件 · 速览 · 胶囊 · Wear 磁贴",
};

const RENDER_MODE_LABELS = {
  fullColor: "全彩 Full Color",
  accented: "强调着色 Accented / Material",
  vibrant: "锁屏毛玻璃 Vibrant",
  alwaysOn: "常亮省电 Always-On",
};

function activeSurfaceProfile(viewportKey = $("viewport-picker")?.value || "mobile") {
  return surfaceProfilesById.get(viewportKey) || null;
}

function isSystemWidgetProfile(profile) {
  return Boolean(profile && (profile.isSystemSurface === true || (profile.kind && profile.kind !== "device" && profile.kind !== "clip")));
}

function enabledProfileSetForModules(moduleIds) {
  const enabled = new Set();
  if (!Array.isArray(moduleIds) || moduleIds.length === 0) return enabled;
  const activeIds = new Set(moduleIds);
  let hasApple = false;
  let hasAndroid = false;
  for (const mod of ecosystemModuleCatalog) {
    if (!activeIds.has(mod.id) || !Array.isArray(mod.profileIds)) continue;
    if (mod.ecosystem === "apple") hasApple = true;
    if (mod.ecosystem === "android") hasAndroid = true;
    for (const profileId of mod.profileIds) enabled.add(profileId);
  }
  if (hasApple) enabled.add("iphone-16-pro");
  if (hasAndroid) enabled.add("pixel-9");
  for (const raw of allSurfaceProfiles) {
    if (raw && enabled.has(raw.id) && typeof raw.companionDeviceId === "string" && raw.companionDeviceId) {
      enabled.add(raw.companionDeviceId);
    }
  }
  return enabled;
}

function populateSurfaceViewportOptions(profiles = allSurfaceProfiles, enabledModules = currentProjectConfig?.ecosystemModules) {
  const picker = $("viewport-picker");
  if (Array.isArray(profiles) && profiles.length > 0) {
    allSurfaceProfiles = profiles;
  }
  if (!picker) return;
  const previousValue = picker.value || "mobile";
  surfaceProfilesById.clear();
  for (const existingGroup of Array.from(picker.querySelectorAll("optgroup[data-surface-group]"))) {
    existingGroup.remove();
  }
  const enabledSet = enabledProfileSetForModules(enabledModules);
  if (enabledSet.size > 0 && Array.isArray(allSurfaceProfiles)) {
    const grouped = new Map();
    for (const raw of allSurfaceProfiles) {
      if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !enabledSet.has(raw.id)) continue;
      const width = Number(raw.width);
      const height = Number(raw.height);
      if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) continue;
      surfaceProfilesById.set(raw.id, raw);
      const groupKey = typeof raw.group === "string" && SURFACE_GROUP_LABELS[raw.group] ? raw.group : "apple-device";
      if (!grouped.has(groupKey)) grouped.set(groupKey, []);
      grouped.get(groupKey).push(raw);
    }
    for (const [groupKey, label] of Object.entries(SURFACE_GROUP_LABELS)) {
      const items = grouped.get(groupKey);
      if (!items || items.length === 0) continue;
      const optgroup = document.createElement("optgroup");
      optgroup.label = label;
      optgroup.dataset.surfaceGroup = groupKey;
      for (const item of items) {
        const option = document.createElement("option");
        option.value = item.id;
        option.textContent = `${item.label} · ${item.width} × ${item.height}`;
        optgroup.appendChild(option);
      }
      picker.appendChild(optgroup);
    }
  }
  const hasPrevious = previousValue === "mobile" || previousValue === "tablet" || previousValue === "desktop" || surfaceProfilesById.has(previousValue);
  picker.value = hasPrevious ? previousValue : "mobile";
  if (!hasPrevious) {
    currentSurfaceRenderMode = "";
    syncSurfaceToolbarControls("mobile");
    updatePreviewPhoneShell("mobile");
    updatePreviewBezelPresentation("mobile");
    layoutPreviewFrame();
  }
}

function renderEcosystemModuleCheckboxes(containerId, inputName, selectedIds = [], disabled = false) {
  const container = $(containerId);
  if (!container) return;
  const selected = new Set(Array.isArray(selectedIds) ? selectedIds : []);
  container.replaceChildren();
  for (const mod of ecosystemModuleCatalog) {
    const label = document.createElement("label");
    label.className = "ecosystem-module-item";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.name = inputName;
    checkbox.value = mod.id;
    checkbox.checked = selected.has(mod.id);
    checkbox.disabled = disabled;
    checkbox.dataset.ecosystem = mod.ecosystem;
    const copy = document.createElement("span");
    copy.className = "ecosystem-module-copy";
    const strong = document.createElement("strong");
    strong.textContent = mod.label;
    const small = document.createElement("small");
    small.textContent = mod.description;
    copy.append(strong, small);
    label.append(checkbox, copy);
    container.appendChild(label);
  }
}

function syncProjectEcosystemUi(config = currentProjectConfig) {
  const enabledModules = Array.isArray(config?.ecosystemModules) ? config.ecosystemModules : [];
  populateSurfaceViewportOptions(allSurfaceProfiles, enabledModules);
  renderEcosystemModuleCheckboxes("ecosystem-module-list", "projectEcosystemModule", enabledModules, !currentId || ecosystemApplying);
  const countChip = $("ecosystem-active-count");
  if (countChip) {
    countChip.textContent = enabledModules.length > 0 ? `已启用 ${enabledModules.length} 项` : "未启用";
  }
  const openBtn = $("open-ecosystem-builder");
  if (openBtn) {
    openBtn.textContent = enabledModules.length > 0 ? `生态/微件 (${enabledModules.length})` : "＋ 生态/微件";
  }
}

function syncSurfaceToolbarControls(viewportKey = $("viewport-picker")?.value || "mobile") {
  const profile = activeSurfaceProfile(viewportKey);
  const modeWrap = $("surface-render-mode-wrap");
  const modeSelect = $("surface-render-mode");
  const jumpButton = $("widget-companion-jump");
  const badge = $("preview-surface-badge");

  if (modeWrap && modeSelect) {
    const modes = Array.isArray(profile?.supportedRenderModes) && profile.supportedRenderModes.length > 0
      ? profile.supportedRenderModes
      : [];
    if (profile && (modes.length > 1 || isSystemWidgetProfile(profile))) {
      modeSelect.innerHTML = "";
      for (const mode of modes) {
        const opt = document.createElement("option");
        opt.value = mode;
        opt.textContent = RENDER_MODE_LABELS[mode] || mode;
        modeSelect.appendChild(opt);
      }
      if (!currentSurfaceRenderMode || !modes.includes(currentSurfaceRenderMode)) {
        currentSurfaceRenderMode = profile.defaultRenderMode || modes[0] || "fullColor";
      }
      modeSelect.value = currentSurfaceRenderMode;
      modeWrap.hidden = false;
    } else {
      modeWrap.hidden = true;
      modeSelect.innerHTML = "";
    }
  }

  if (jumpButton) {
    const companionId = profile?.companionDeviceId;
    const companionProfile = companionId ? surfaceProfilesById.get(companionId) : null;
    if (profile && companionProfile) {
      const hotspotCount = Array.isArray(latestWidgetSnapshot?.hotspots) ? latestWidgetSnapshot.hotspots.length : 0;
      const primaryLabel = latestWidgetSnapshot?.hotspots?.[0]?.label || "";
      jumpButton.hidden = false;
      jumpButton.textContent = hotspotCount > 0
        ? `打开 ${companionProfile.shortLabel || "宿主 App"} · ${hotspotCount} 热区 ↗`
        : `打开 ${companionProfile.shortLabel || "宿主 App"} ↗`;
      jumpButton.title = primaryLabel
        ? `触发首选深链「${primaryLabel}」并在 ${companionProfile.label} 中打开`
        : `在关联主设备 ${companionProfile.label} 中打开深链预览`;
    } else {
      jumpButton.hidden = true;
    }
  }

  if (badge) {
    if (profile && (isSystemWidgetProfile(profile) || profile.kind === "clip")) {
      const hotspotCount = Array.isArray(latestWidgetSnapshot?.hotspots) ? latestWidgetSnapshot.hotspots.length : 0;
      const modeLabel = currentSurfaceRenderMode || profile.defaultRenderMode || "fullColor";
      badge.textContent = hotspotCount > 0
        ? `${profile.shortLabel || profile.label} · ${modeLabel} · ${hotspotCount} Deep Links`
        : `${profile.shortLabel || profile.label} · ${modeLabel}`;
      badge.hidden = false;
    } else {
      badge.hidden = true;
      badge.textContent = "";
    }
  }
}

async function loadPreviewDevice() {
  if (previewDevicePromise) return previewDevicePromise;
  renderEcosystemModuleCheckboxes("create-ecosystem-list", "createEcosystemModule", [], false);
  renderEcosystemModuleCheckboxes("ecosystem-module-list", "projectEcosystemModule", [], true);
  previewDevicePromise = api("/api/preview/device").then((payload) => {
    if (Array.isArray(payload?.profiles)) {
      allSurfaceProfiles = payload.profiles;
      populateSurfaceViewportOptions(allSurfaceProfiles, currentProjectConfig?.ecosystemModules || []);
    }
    const profile = normalizePreviewDeviceProfile(payload);
    applyPreviewDeviceProfile(profile);
    syncSurfaceToolbarControls();
    return profile;
  });
  return previewDevicePromise;
}

let noticeTimer;
let noticeCopyText = "";

function persistBrowserDiagnostic(kind, error, unhandled = false) {
  if (!currentId) return;
  let normalized;
  try { normalized = normalizeError(error); }
  catch { normalized = new Error(String(error)); }
  // Reporting failures go to the browser console, avoiding a recursive error toast.
  void api(`/api/projects/${encodeURIComponent(currentId)}/diagnostics`, {
    method: "POST",
    body: JSON.stringify({ kind, message: normalized.message.slice(0, 8192), unhandled,
      error: { name: normalized.name, message: normalized.message.slice(0, 8192), stack: normalized.stack?.slice(0, 16384) } }),
  }).catch((failure) => console.warn("Diagnostic record could not be persisted", failure));
}

const initialStudioParams = new URLSearchParams(window.location.search);
let pendingInitialOpenPath = initialStudioParams.get("open") || "";
let pendingInitialProjectId = initialStudioParams.get("project") || "";
let pendingInitialFile = initialStudioParams.get("file") || "";
let pendingInitialOpenUri = initialStudioParams.get("uri") || "";

window.addEventListener("error", (event) => {
  if (event.error || event.message) persistBrowserDiagnostic("crash", event.error || event.message, true);
});
window.addEventListener("unhandledrejection", (event) => persistBrowserDiagnostic("crash", event.reason, true));

$("export-diagnostics")?.addEventListener("click", () => {
  if (!currentId) return;
  const link = document.createElement("a");
  link.href = `/api/projects/${encodeURIComponent(currentId)}/diagnostics?download=1`;
  link.download = `${currentId}-diagnostics.json`;
  link.click();
});

async function writeClipboardText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {}
  }
  try {
    const input = document.createElement("textarea");
    input.value = text;
    input.setAttribute("readonly", "");
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.append(input);
    input.select();
    const copied = document.execCommand("copy");
    input.remove();
    return Boolean(copied);
  } catch {
    return false;
  }
}

async function copyErrorNotice() {
  if (noticeEl.hidden || noticeEl.dataset.tone !== "error" || !noticeCopyText) return;
  const text = noticeCopyText;
  const copied = await writeClipboardText(text);
  if (noticeEl.hidden || noticeEl.dataset.tone !== "error" || noticeCopyText !== text) return;
  clearTimeout(noticeTimer);
  const messageEl = $("notice-message");
  const iconEl = $("notice-icon");
  if (!copied) {
    noticeEl.dataset.copied = "failed";
    messageEl.textContent = `${text}\n（自动复制失败，请手动选择复制）`;
    return;
  }
  noticeEl.dataset.copied = "true";
  iconEl.textContent = "✓";
  messageEl.textContent = `已复制错误信息：${text}`;
  noticeTimer = setTimeout(() => {
    if (noticeEl.hidden || noticeEl.dataset.tone !== "error" || noticeCopyText !== text) return;
    delete noticeEl.dataset.copied;
    iconEl.textContent = "!";
    messageEl.textContent = text;
  }, 1800);
}

function showNotice(message, tone = "error") {
  clearTimeout(noticeTimer);
  const kind = ["success", "info", "error"].includes(tone) ? tone : "error";
  const text = localizedMessage(message);
  if (kind === "error") persistBrowserDiagnostic("log", normalizeError(message));
  noticeCopyText = kind === "error" ? text : "";
  delete noticeEl.dataset.copied;
  noticeEl.dataset.tone = kind;
  noticeEl.setAttribute("role", kind === "error" ? "alert" : "status");
  if (kind === "error") {
    noticeEl.title = "点击复制错误信息";
  } else {
    noticeEl.removeAttribute("title");
  }
  $("notice-icon").textContent = { success: "✓", info: "i", error: "!" }[kind];
  const messageEl = $("notice-message");
  messageEl.textContent = text;
  if (kind === "error") {
    messageEl.setAttribute("role", "button");
    messageEl.tabIndex = 0;
    messageEl.setAttribute("aria-label", "点击复制错误信息");
  } else {
    messageEl.removeAttribute("role");
    messageEl.removeAttribute("tabindex");
    messageEl.removeAttribute("aria-label");
  }
  noticeEl.hidden = false;
  if (kind !== "error") noticeTimer = setTimeout(clearNotice, kind === "success" ? 3500 : 5000);
}

function clearNotice() {
  clearTimeout(noticeTimer);
  noticeTimer = undefined;
  noticeCopyText = "";
  delete noticeEl.dataset.copied;
  noticeEl.hidden = true;
  noticeEl.removeAttribute("title");
  const messageEl = $("notice-message");
  messageEl.textContent = "";
  messageEl.removeAttribute("role");
  messageEl.removeAttribute("tabindex");
  messageEl.removeAttribute("aria-label");
}

$("notice-close")?.addEventListener("click", (event) => {
  event.stopPropagation();
  clearNotice();
});
noticeEl.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest("#notice-close")) {
    clearNotice();
    return;
  }
  if (noticeEl.dataset.tone === "error") {
    const selection = window.getSelection?.();
    if (selection && !selection.isCollapsed && noticeEl.contains(selection.anchorNode)) return;
    void copyErrorNotice();
    return;
  }
  clearNotice();
});
noticeEl.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    clearNotice();
    return;
  }
  if (noticeEl.dataset.tone === "error" && (event.key === "Enter" || event.key === " ") && !(event.target instanceof Element && event.target.closest("#notice-close"))) {
    event.preventDefault();
    void copyErrorNotice();
  }
});

function setText(id, value) {
  const element = $(id);
  if (element) element.textContent = value;
}

function setProjectState(label, kind = "") {
  const state = $("project-state");
  state.textContent = label;
  state.className = `state-chip${kind ? ` ${kind}` : ""}`;
}

function hasUnsavedProjectConfig() {
  if (!currentProjectConfig) return false;
  return PROJECT_CONFIG_FIELDS.some(([id, field]) => String($(id)?.value ?? "") !== String(currentProjectConfig[field] ?? ""));
}

function hasAppIdChange() {
  return Boolean(currentProjectConfig)
    && String($("config-app-id")?.value ?? "") !== String(currentProjectConfig.appId ?? "");
}

function setConfigSaveFeedback(message, kind = "") {
  const status = $("config-save-status");
  if (!status) return;
  status.textContent = message;
  status.className = `status-text${kind ? ` ${kind}` : ""}`;
}

function updateConfigSaveFeedback() {
  if (saving) return;
  if (!currentId) {
    setConfigSaveFeedback("尚未选择项目");
    return;
  }
  setConfigSaveFeedback(
    hasUnsavedProjectConfig() ? "有未保存配置" : "配置已保存",
    hasUnsavedProjectConfig() ? "warn" : "good",
  );
}

function markDirty(value = true) {
  dirty = value;
  setText("save-status", dirty ? "有未保存修改" : "已保存");
  if (!currentId) setProjectState("未选择项目");
  else if (dirty) setProjectState("有未保存修改");
  else if (currentStatus?.busy) setProjectState("构建中…", "good");
  else if (currentStatus?.error) setProjectState("构建失败", "bad");
  else if (currentStatus?.builtRevision === currentStatus?.revision) setProjectState("已构建", "good");
  else setProjectState("需要构建");
  updateActionStates();
}

function updateActionStates() {
  if ($("export-diagnostics")) $("export-diagnostics").disabled = !currentId;
  const hasProject = Boolean(currentId);
  const busy = Boolean(currentStatus?.busy);
  const built = Boolean(currentStatus && currentStatus.builtRevision === currentStatus.revision && !currentStatus.error);
  const publishTarget = activePublishTarget();
  const publishTargetAvailable = publishTargetContext
    ? Boolean(publishTarget && publishTarget.canSelect !== false && publishTarget.ownerProjectId && publishTarget.projectId === currentId)
    : !publishTarget || publishTarget.kind !== "reused" || (publishTarget.canSelect !== false && publishTarget.ownerProjectId && publishTarget.projectId === currentId);
  const canPublishCurrentTarget = hasProject && built && publishTargetAvailable && publishTarget?.canPublish !== false && !publishTargetsLoading && !dirty && !hasUnsavedProjectConfig() && !resourcesDirty;
  const workLocked = busy || startingBuild || startingDeploy || Boolean(activeDeploy && activeDeploy.status !== "running") || saving || publishing || resourcesSaving || cosBusy || cfBusy || packagesBusy;
  $("save").disabled = !hasProject || !dirty || saving || workLocked;
  $("save-config").disabled = !hasProject || !hasUnsavedProjectConfig() || workLocked;
  $("build").disabled = !hasProject || !publishTargetAvailable || workLocked || saving;
  for (const id of PROJECT_CONFIG_INPUTS) {
    const field = $(id);
    if (field) field.disabled = !hasProject || sourceEl.disabled || saving || publishing;
  }
  const buildField = $("config-build");
  if (buildField) buildField.disabled = !hasProject || sourceEl.disabled || publishing;
  if ($("novel-open")) $("novel-open").disabled = !hasProject || workLocked;
  $("refresh-source").disabled = !hasProject || workLocked;
  $("refresh-preview").disabled = !hasProject || busy;
  previewFrame.style.pointerEvents = busy ? "none" : "";
  $("preview-open").disabled = !previewPath;
  if ($("copy-preview-link")) $("copy-preview-link").disabled = !previewPath;
  if ($("source-toggle")) $("source-toggle").disabled = !hasProject;
  if ($("source-split-toggle")) $("source-split-toggle").disabled = !hasProject;
  $("capture-preview").disabled = !previewReady;
  const gpuToggle = $("preview-gpu-toggle");
  if (gpuToggle) {
    gpuToggle.hidden = !previewGpuAvailable;
    gpuToggle.disabled = !built || busy || dirty || !gpuPreviewSupportsViewport();
    gpuToggle.setAttribute("aria-pressed", String(previewGpuActive));
  }
  if ($("toggle-regions")) {
    $("toggle-regions").disabled = !previewReady || previewGpuActive;
    $("toggle-regions").title = previewGpuActive ? "区域 ID 需要 Flutter 预览" : "显示 Flutter 预览中的区域 ID";
    $("toggle-regions").setAttribute("aria-pressed", String(previewRegionsEnabled));
  }
  $("device-picker").disabled = !hasProject || !devices.length || Boolean(activeDeploy);
  $("deploy").disabled = !hasProject || !built || busy || startingDeploy || !$("device-picker").value || Boolean(activeDeploy);
  $("deploy-cancel").hidden = !activeDeploy;
  const wechatStart = $("wechat-start");
  const wechatStop = $("wechat-stop");
  const wechatOpen = $("wechat-open");
  const wechatRunning = wechatState.state === "running";
  const wechatBuilding = wechatState.state === "building";
  const wechatBusy = startingWechat || stoppingWechat || wechatBuilding;
  if (wechatStart) wechatStart.disabled = !hasProject || wechatBusy || wechatRunning || workLocked;
  if (wechatStop) {
    wechatStop.hidden = !wechatBuilding && !wechatRunning;
    wechatStop.disabled = !hasProject || startingWechat || stoppingWechat || (!wechatBuilding && !wechatRunning);
  }
  if (wechatOpen) {
    const url = wechatRunning && wechatState.url ? wechatState.url : "";
    wechatOpen.hidden = !url;
    if (url) wechatOpen.href = url;
    else wechatOpen.removeAttribute("href");
  }
  $("publish-test").disabled = !canPublishCurrentTarget || workLocked;
  if ($("open-version-manager-from-signing")) $("open-version-manager-from-signing").disabled = !hasProject;
  if ($("publish-target-picker")) $("publish-target-picker").disabled = !hasProject || publishTargetsLoading || workLocked;
  if ($("publish-target-channel")) $("publish-target-channel").disabled = !hasProject || publishTargetsLoading || workLocked;
  $("versions-open").disabled = !hasProject;
  $("versions-refresh").disabled = !hasProject || versionsLoading;
  updatePublishTargetIndicators();
  updateResourceActionStates(workLocked);
  updateCosActionStates(workLocked);
  updateCloudflareActionStates(workLocked);
  updatePackagesActionStates(workLocked);
}

function setPublishEditorLocked(locked) {
  sourceEl.readOnly = locked;
  if ($("file-picker")) $("file-picker").disabled = locked || !currentId;
  for (const id of [...PROJECT_CONFIG_INPUTS, "config-build"]) {
    const field = $(id);
    if (field) field.disabled = locked || !currentId;
  }
}

function currentProjectTitle() {
  return $("config-name")?.value || projects.find((project) => project.id === currentId)?.name || currentId || "项目";
}

function currentProjectAppId() {
  return $("config-app-id")?.value || projects.find((project) => project.id === currentId)?.appId || "—";
}

function updateProjectHeading(project, config = project) {
  const name = config?.name || project?.name || currentId || "项目";
  const appId = config?.appId || project?.appId || "—";
  const source = project?.source?.kind === "catalog-miniapp" ? project.source : null;
  if (source) {
    setText("project-title", `${source.sourceProjectTitle} › MiniApp ${name}`);
    setText("project-subtitle", `${source.sourceProjectTitle} 内 MiniApp · 源码 ${source.sourcePath} · ${appId}`);
    return;
  }
  setText("project-title", name);
  setText("project-subtitle", project?.directory || `${appId} · ${config?.framework || "solid"} · ${config?.entry || "app.tsx"}`);
}

function activePublishTarget() {
  const targets = Array.isArray(publishTargets?.targets) ? publishTargets.targets : [];
  if (publishTargetContext && publishTargets && publishTargetContext.sourceProjectId === publishTargets.currentProjectId) {
    return targets.find((target) => target.appId === publishTargetContext.appId) || null;
  }
  return targets.find((target) => target.kind === "root" && target.projectId === currentId)
    || targets.find((target) => target.projectId === currentId)
    || null;
}

function publishChannelLabel(channel = publishTargetChannel) {
  return channel === "release" ? "稳定版" : "测试版";
}

function publishTargetLabel() {
  if (publishTargetContext && publishTargets && publishTargetContext.sourceProjectId === publishTargets.currentProjectId) {
    const target = activePublishTarget();
    const title = `MiniApp ${target?.title || publishTargetContext.appId}`;
    const sourceTitle = target?.sourceProjectTitle || publishTargetContext.sourceProjectTitle;
    return sourceTitle ? `${sourceTitle} › ${title}` : `${title} (${publishTargetContext.appId})`;
  }
  return `主应用 ${currentProjectAppId()} · ${currentProjectTitle()}`;
}

function publishTargetStatusLabel() {
  if (!currentId) return "请选择项目";
  if (publishTargetsLoading) return "正在读取发布目标…";
  const target = activePublishTarget();
  if (target?.kind === "reused" && target.canSelect === false) return target.reason || "此应用暂不可发布";
  if (target?.kind === "reused" && target.projectId !== currentId) return "MiniApp 源码上下文已变化，请重新选择目标";
  if (target?.busy) return "构建中";
  if (target?.canPublish === false && target.built === false) return "需先构建";
  if (target?.kind === "root" && target.canPublish === false && target.reason) return target.reason;
  if (dirty) return "有未保存修改，请先保存并构建";
  if (resourcesDirty) return "资源策略尚未保存";
  const status = currentStatus;
  if (status?.busy) return "构建中";
  if (status?.error) return "最近构建失败，请重新构建";
  if (status && status.builtRevision === status.revision) return "已构建，可发布";
  return "需先构建";
}

function publishTargetScopeLabel() {
  const target = activePublishTarget();
  const channel = `当前显示：${publishChannelLabel()}发布状态。`;
  if (target?.kind === "reused" || (publishTargetContext && publishTargets && publishTargetContext.sourceProjectId === publishTargets.currentProjectId)) {
    const sourceTitle = target?.sourceProjectTitle || publishTargetContext?.sourceProjectTitle;
    const sourcePath = target?.sourcePath || publishTargetContext?.sourcePath;
    const sourceLabel = sourcePath
      ? `${sourceTitle || publishTargetContext?.sourceProjectId} 内 MiniApp ${target?.title || publishTargetContext?.appId} · 源码 ${sourcePath}`
      : `MiniApp 发布记录 ${target?.ownerTitle || publishTargetContext?.ownerTitle || currentProjectTitle()}`;
    const version = target?.publishedVersion
      ? `当前已发布 v${target.publishedVersion}${target.publishedBuild !== undefined ? ` build ${target.publishedBuild}` : ""}`
      : `此频道暂无已发布版本`;
    return `发布范围：${sourceLabel} · ${version}。${channel}`;
  }
  return `发布范围：主应用 ${currentProjectAppId()}，并包含此项目内普通子包；复用 MiniApp 使用各自所属项目的已发布版本。${channel}`;
}

function renderPublishTargetPicker() {
  const picker = $("publish-target-picker");
  const channelPicker = $("publish-target-channel");
  const reusedList = $("publish-target-reused");
  if (channelPicker) channelPicker.value = publishTargetChannel;
  if (!picker) return;
  picker.replaceChildren();
  const targets = Array.isArray(publishTargets?.targets) ? publishTargets.targets : [];
  const contextSourceProjectId = publishTargetContext?.sourceProjectId;
  const fallbackSourceRoot = contextSourceProjectId && contextSourceProjectId !== currentId
    ? {
      projectId: contextSourceProjectId,
      appId: projects.find((project) => project.id === contextSourceProjectId)?.appId || contextSourceProjectId,
      title: projects.find((project) => project.id === contextSourceProjectId)?.name || contextSourceProjectId,
      kind: "root",
    }
    : null;
  const contextRoot = fallbackSourceRoot
    ? targets.find((target) => target.kind === "root" && target.projectId === contextSourceProjectId) || fallbackSourceRoot
    : null;
  const root = targets.find((target) => target.kind === "root" && target.projectId === currentId)
    || targets.find((target) => target.kind === "root" && target.projectId === publishTargets?.currentProjectId)
    || contextRoot
    || targets.find((target) => target.projectId === currentId)
    || {
      projectId: currentId,
      appId: currentProjectAppId(),
      title: currentProjectTitle(),
      kind: "root",
    };
  const optionTargets = targets.length ? [...targets] : currentId ? [root] : [];
  if (contextRoot && !optionTargets.some((target) => target.kind === "root" && target.projectId === contextSourceProjectId)) {
    optionTargets.unshift(contextRoot);
  }
  const selectedContextTargetExists = Boolean(
    publishTargetContext
    && optionTargets.some((target) => target.appId === publishTargetContext.appId),
  );
  const needsReturnPlaceholder = Boolean(
    publishTargetContext
    && contextSourceProjectId !== currentId
    && !selectedContextTargetExists,
  );
  if (needsReturnPlaceholder) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = `MiniApp ${publishTargetContext.appId} 暂不可用 · 选择主应用返回`;
    picker.append(option);
  }
  for (const target of optionTargets) {
    const option = document.createElement("option");
    option.value = target.appId || target.projectId || "";
    if (target.kind === "reused") {
      const latest = target.publishedVersion
        ? ` · 当前已发布 v${target.publishedVersion}${target.publishedBuild !== undefined ? ` build ${target.publishedBuild}` : ""}`
        : " · 尚无此频道发布记录";
      const sourceLabel = target.sourcePath
        ? `${target.sourceProjectTitle || publishTargets?.currentProjectId} 内 MiniApp ${target.title || target.appId} · 源码 ${target.sourcePath}`
        : `MiniApp ${target.title || target.appId} (${target.appId}) · 发布项目 ${target.ownerTitle || target.ownerProjectId}`;
      option.textContent = `${sourceLabel}${latest}`;
      option.title = `${sourceLabel} · ${target.appId}`;
      option.disabled = target.canSelect === false || !target.ownerProjectId;
    } else {
      option.textContent = `主应用 ${target.appId || currentProjectAppId()} · ${target.title || currentProjectTitle()}`;
    }
    picker.append(option);
  }
  if (!optionTargets.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = publishTargetsLoading ? "正在加载发布目标…" : "无可用发布目标";
    picker.append(option);
  }
  const preferredAppId = needsReturnPlaceholder
    ? ""
    : publishTargetContext && publishTargets && publishTargetContext.sourceProjectId === publishTargets.currentProjectId
    ? publishTargetContext.appId
    : root.appId || currentProjectAppId();
  picker.value = preferredAppId;
  if (picker.selectedIndex < 0 && picker.options.length) picker.selectedIndex = 0;

  if (reusedList) {
    reusedList.replaceChildren();
    const reused = targets.filter((target) => target.kind === "reused");
    reusedList.hidden = reused.length === 0;
    for (const target of reused) {
      const row = document.createElement("div");
      row.className = "publish-target-reused-item";
      const title = document.createElement("strong");
      title.textContent = target.sourcePath
        ? `${target.sourceProjectTitle || publishTargets?.currentProjectId} 内 MiniApp · ${target.title || target.appId}`
        : `MiniApp ${target.title || target.appId} (${target.appId})`;
      const detail = document.createElement("span");
      const owner = target.ownerTitle || target.ownerProjectId || "所属项目未解析";
      const ownerIdentity = target.ownerProjectId ? ` (${target.ownerProjectId})` : "";
      const ownerVersion = target.version ? ` · 项目 v${target.version}` : "";
      const ownerBuild = target.build !== undefined ? ` build ${target.build}` : "";
      const published = target.publishedVersion
        ? ` · ${publishChannelLabel()}当前已发布 v${target.publishedVersion}${target.publishedBuild !== undefined ? ` build ${target.publishedBuild}` : ""}`
        : " · 尚无此频道发布版本";
      const buildState = target.busy ? " · 正在构建" : target.built ? " · 已构建" : " · 需先构建";
      detail.textContent = target.canSelect === false || !target.ownerProjectId
        ? `${target.reason || "无法解析此 MiniApp 的所属项目。"}`
        : target.sourcePath
          ? `源码：${target.sourcePath} · ${buildState}${published}`
          : `发布项目：${owner}${ownerIdentity}${ownerVersion}${ownerBuild}${buildState}${published}`;
      row.append(title, detail);
      reusedList.append(row);
    }
  }
  updatePublishTargetIndicators();
}

function updatePublishTargetIndicators() {
  const targetName = publishTargetLabel();
  const full = currentId ? `目标：${targetName} · ${publishChannelLabel()}` : "目标：请选择项目";
  const label = $("publish-target-action-label");
  if (label) {
    label.textContent = full;
    label.title = full;
  }
  const summary = $("publish-target-summary");
  if (summary) {
    summary.replaceChildren();
    const title = document.createElement("strong");
    title.textContent = targetName;
    const detail = document.createElement("span");
    detail.textContent = publishTargetStatusLabel();
    summary.append(title, detail);
  }
  const scope = $("publish-target-scope");
  if (scope) {
    scope.textContent = publishTargetsError
      ? `${publishTargetScopeLabel()} MiniApp 目标读取失败：${publishTargetsError}`
      : publishTargetScopeLabel();
  }
  const testInfo = $("test-publish-info");
  if (testInfo && currentStatus?.publish?.channel === "test") {
    testInfo.hidden = publishTargetChannel !== "test";
  }
  const build = $("build");
  if (build) build.title = `构建当前源码上下文：${currentProjectTitle()}（⌘B）`;
  const action = $("publish-test");
  if (action) action.textContent = publishTargetChannel === "test" ? "发布测试包" : "发布稳定版";
  setText("publish-channel-eyebrow", publishTargetChannel === "test" ? "测试包 / 热更新" : "稳定版");
  setText("test-publish-title", publishTargetChannel === "test" ? "发布到本地版本后端" : "发布到稳定频道");
  setText("publish-channel-description", publishTargetChannel === "test"
    ? "为递增的测试构建签名，并以只读方式提供给同一局域网中的模拟器和设备。"
    : "将此构建签名并更新稳定频道。版本状态来自所选应用当前源码上下文。");
}

function setPublishTargets(payload, error = "") {
  publishTargets = payload && Array.isArray(payload.targets) ? payload : null;
  publishTargetsError = error ? String(error.message || error) : "";
  publishTargetsLoading = false;
  renderPublishTargetPicker();
  updateActionStates();
}

function publishTargetsProjectId() {
  return publishTargetContext?.sourceProjectId || currentId;
}

async function refreshPublishTargets(projectId = publishTargetsProjectId(), channel = publishTargetChannel) {
  if (!projectId) return null;
  const editorProjectId = currentId;
  const generation = ++publishTargetsGeneration;
  publishTargetsLoading = true;
  publishTargetsError = "";
  updateActionStates();
  try {
    const payload = await api(`/api/projects/${encodeURIComponent(projectId)}/publish-targets?channel=${encodeURIComponent(channel)}`);
    if (currentId !== editorProjectId || generation !== publishTargetsGeneration) return null;
    setPublishTargets(payload);
    return payload;
  } catch (error) {
    if (currentId !== editorProjectId || generation !== publishTargetsGeneration) return null;
    setPublishTargets(null, error);
    return null;
  }
}

async function switchPublishTargetChannel(channel) {
  if (channel !== "test" && channel !== "release") return;
  if (channel === publishTargetChannel && !publishTargetsLoading) return publishTargets;
  publishTargetChannel = channel;
  if ($("publish-target-channel")) $("publish-target-channel").value = channel;
  updateActionStates();
  const payload = await refreshPublishTargets();
  if (!payload) {
    showNotice(`无法读取${publishChannelLabel(channel)}频道的发布目标。请刷新后重试。`, "error");
    return null;
  }
  const context = publishTargetContext;
  const target = context && payload?.targets?.find((entry) => entry.appId === context.appId && entry.kind === "reused");
  let projectAligned = true;
  if (context && target) {
    if (target.canSelect === false || !target.ownerProjectId) {
      showNotice(target.reason || `MiniApp ${target.appId} 在${publishChannelLabel(channel)}频道尚无可用的所属项目。`, "info");
      return payload;
    }
    const ownerProjectId = target.ownerProjectId;
    if (ownerProjectId !== currentId) {
      const nextContext = {
        ...context,
        ownerProjectId,
        ownerTitle: target.ownerTitle || target.title || ownerProjectId,
        sourceProjectTitle: target.sourceProjectTitle || context.sourceProjectTitle,
        sourcePath: target.sourcePath || context.sourcePath,
      };
      await selectProject(ownerProjectId, { publishTargetContext: nextContext });
      projectAligned = currentId === ownerProjectId && !sourceEl.disabled;
    } else if (ownerProjectId === currentId) {
      publishTargetContext = {
        ...context,
        ownerProjectId,
        ownerTitle: target.ownerTitle || target.title || ownerProjectId,
        sourceProjectTitle: target.sourceProjectTitle || context.sourceProjectTitle,
        sourcePath: target.sourcePath || context.sourcePath,
      };
      updatePublishTargetIndicators();
    }
  } else if (context) {
    projectAligned = false;
  }
  const active = context && payload?.targets?.find((entry) => entry.appId === context.appId);
  if (!projectAligned) {
    showNotice(`已切换至${publishChannelLabel(channel)}频道，但所选 MiniApp 所属项目尚未打开。请处理未保存修改后再点“切换到所选应用”。`, "info");
    return payload;
  }
  const projectText = active?.kind === "reused"
    ? `MiniApp ${active.appId} · 所属项目 ${active.ownerTitle || active.projectId} · ${active.busy ? "构建中" : active.built ? "已构建" : "需先构建"}${active.publishedVersion ? ` · 当前已发布 v${active.publishedVersion}${active.publishedBuild !== undefined ? ` build ${active.publishedBuild}` : ""}` : " · 此频道暂无已发布版本"}。`
    : `主应用 ${currentProjectAppId()}。`;
  showNotice(`已切换至${publishChannelLabel(channel)}频道。${projectText}请确认目标和状态后再点击发布。`, "info");
  return payload;
}

function clearSelectedProjectState() {
  stopBuildPolling();
  stopDeployPolling();
  invalidateWechatRequests();
  currentId = null;
  currentStatus = null;
  currentProjectConfig = null;
  projectFiles = [];
  currentFile = "app.tsx";
  sourceEl.value = "";
  setText("source-panel-title", "没有源文件");
  setText("source-bytes", "—");
  setText("source-revision", "修订版 —");
  $("file-picker").replaceChildren();
  previewPath = "";
  previewReady = false;
  previewHasFrame = false;
  previewStarted = false;
  previewRevision = null;
  previewGeneration = null;
  resetPreviewSurface();
  resetWechatPresentation();
  publishTargetContext = null;
  publishTargets = null;
  publishTargetsLoading = false;
  publishTargetsError = "";
  publishTargetsGeneration += 1;
  renderPublishTargetPicker();
  versionSnapshot = null;
  cosSnapshot = null;
  cosFormProjectId = null;
  versionsLoading = false;
  versionsGeneration += 1;
  renderVersionManagement();
  resetResources();
  syncProjectEcosystemUi(null);
  for (const id of PROJECT_CONFIG_INPUTS) {
    const field = $(id);
    if (field) field.value = "";
  }
  if ($("config-build")) $("config-build").value = 0;
  renderStatus(null);
  markDirty(false);
  setEnabled(false);
  updateConfigSaveFeedback();
  setText("project-title", "请选择项目");
  setText("project-subtitle", "创建 SDK 项目、编辑 JS 界面并在本地预览。");
  setProjectState("未选择项目");
}

async function removeProjectFromListUi(project) {
  if (!project.canRemove || removingProjectId) return;
  const affectedIds = new Set([
    project.id,
    ...projects
      .filter((item) => item.source?.kind === "catalog-miniapp" && item.source.parentProjectId === project.id)
      .map((item) => item.id),
  ]);
  const removingSelected = Boolean(currentId && affectedIds.has(currentId));
  if (
    saving ||
    resourcesSaving ||
    publishing ||
    startingBuild ||
    ecosystemApplying ||
    cosBusy ||
    startingDeploy ||
    startingWechat ||
    stoppingWechat ||
    project.status?.busy ||
    (removingSelected && (currentStatus?.busy || activeDeploy || ["building", "running"].includes(wechatState.state)))
  ) {
    showNotice("请先等待或停止当前保存、构建、发布、预览或部署任务，再从列表中移除项目。", "info");
    return;
  }
  if (removingSelected && (dirty || hasUnsavedProjectConfig() || resourcesDirty)) {
    showNotice("当前项目有未保存的源文件、配置或资源修改，请先保存或丢弃修改后再从列表中移除。", "info");
    return;
  }
  const childCount = affectedIds.size - 1;
  const title = project.name || project.id;
  const childHint = childCount > 0 ? `\n关联的 ${childCount} 个目录 MiniApp 条目也会一并从列表中移除。` : "";
  if (
    !window.confirm(
      `确定将「${title}」（${project.id}）从项目列表中移除吗？${childHint}\n\n此操作不会删除磁盘上的项目源文件或已发布版本数据，后续可通过“打开项目”重新恢复。`,
    )
  ) {
    return;
  }
  clearNotice();
  removingProjectId = project.id;
  renderProjects();
  try {
    const { removedIds } = await api(`/api/projects/${encodeURIComponent(project.id)}`, { method: "DELETE" });
    projects = projects.filter(item => !removedIds.includes(item.id));
    try {
      const stored = localStorage.getItem(projectSelectionStorageKey);
      if (removedIds.includes(stored)) localStorage.removeItem(projectSelectionStorageKey);
    } catch {}
    if (removedIds.includes(currentId)) {
      clearSelectedProjectState();
      await loadProjects();
    } else if (currentId) {
      void refreshPublishTargets();
    }
    showNotice(`已从项目列表中移除「${title}」（源文件与已发布数据已保留）。`, "success");
  } catch (error) {
    showNotice(error);
  } finally {
    removingProjectId = null;
    renderProjects();
  }
}

function renderProjects() {
  projectsEl.replaceChildren();
  const renderProjectRow = (project, nested = false) => {
    const row = document.createElement("div");
    row.className = "project-item-row";
    const button = document.createElement("button");
    button.type = "button";
    if (project.directory) button.title = project.directory;
    const canRemove = !nested && project.canRemove;
    button.className = `project-item${nested ? " project-item-nested" : ""}${project.id === currentId ? " active" : ""}`;
    const name = document.createElement("strong");
    name.textContent = nested ? `MiniApp · ${project.name || project.id}` : project.name || project.id;
    const detail = document.createElement("small");
    detail.textContent = nested && project.source?.kind === "catalog-miniapp"
      ? `${project.source.sourcePath} · ${project.appId} · v${project.version || "—"}`
      : `${project.appId || project.id} · v${project.version || "—"}`;
    button.append(name, detail);
    button.addEventListener("click", () => {
      const source = project.source?.kind === "catalog-miniapp" ? project.source : null;
      const publishTargetContext = source ? {
        sourceProjectId: source.parentProjectId,
        sourceProjectTitle: source.sourceProjectTitle,
        sourcePath: source.sourcePath,
        appId: project.appId,
        ownerProjectId: project.id,
        ownerTitle: project.name || project.id,
      } : null;
      void selectProject(project.id, publishTargetContext ? { publishTargetContext } : {});
    });
    row.append(button);
    if (canRemove) {
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "project-item-remove";
      removeBtn.dataset.removeProject = project.id;
      const label = `从项目列表移除 ${project.name || project.id}`;
      removeBtn.title = `${label}（保留源文件与已发布数据）`;
      removeBtn.setAttribute("aria-label", label);
      removeBtn.textContent = "×";
      removeBtn.disabled = Boolean(removingProjectId);
      removeBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        void removeProjectFromListUi(project);
      });
      row.append(removeBtn);
    }
    return row;
  };

  const sourceProjects = projects.filter((project) => project.source?.kind === "catalog-miniapp");
  const parentProjects = projects.filter((project) => project.source?.kind !== "catalog-miniapp");
  const renderedSourceIds = new Set();
  const renderSourceGroup = (title, children) => {
    if (!children.length) return;
    const group = document.createElement("section");
    group.className = "project-child-group";
    const heading = document.createElement("span");
    heading.className = "project-child-heading";
    heading.textContent = `${title} · MiniApps`;
    group.append(heading);
    for (const child of children) {
      renderedSourceIds.add(child.id);
      group.append(renderProjectRow(child, true));
    }
    projectsEl.append(group);
  };

  for (const project of parentProjects) {
    projectsEl.append(renderProjectRow(project));
    renderSourceGroup(
      project.name || project.id,
      sourceProjects.filter((source) => source.source.parentProjectId === project.id),
    );
  }
  const ungroupedSources = sourceProjects.filter((project) => !renderedSourceIds.has(project.id));
  if (ungroupedSources.length) {
    const first = ungroupedSources[0].source;
    renderSourceGroup(first.sourceProjectTitle, ungroupedSources);
  }
  if (!projects.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "还没有项目。";
    projectsEl.append(empty);
  }
}

function fileUrl(projectId, filePath) {
  const encoded = filePath.split("/").map((part) => encodeURIComponent(part)).join("/");
  return `/api/projects/${encodeURIComponent(projectId)}/files/${encoded}`;
}

function renderFilePicker(files) {
  projectFiles = (files || []).map((file) => typeof file === "string" ? file : file.path).filter(Boolean);
  const picker = $("file-picker");
  picker.replaceChildren();
  for (const file of projectFiles) {
    const option = document.createElement("option");
    option.value = file;
    option.textContent = file;
    picker.append(option);
  }
  picker.value = projectFiles.includes(currentFile) ? currentFile : projectFiles[0] || "";
  setText("source-panel-title", picker.value || "没有源文件");
}

async function loadFile(filePath) {
  if (!currentId || !filePath) return;
  const content = await api(fileUrl(currentId, filePath));
  currentFile = content.path;
  sourceEl.value = content.content;
  $("file-picker").value = currentFile;
  setText("source-panel-title", currentFile);
  setText("source-bytes", `${Number(content.bytes || 0).toLocaleString()} 字节`);
  markDirty(false);
}

function wechatPath(projectId) {
  return `/api/projects/${encodeURIComponent(projectId)}/wechat`;
}

function readWechatState(payload) {
  const value = payload && typeof payload === "object" && payload.state && typeof payload.state === "object"
    ? payload.state
    : payload;
  const state = WECHAT_STATES.has(value?.state) ? value.state : "idle";
  const logs = Array.isArray(value?.logs) ? value.logs.map((entry) => String(entry)) : [];
  return {
    state,
    targetId: typeof value?.targetId === "string" ? value.targetId : "",
    url: typeof value?.url === "string" ? value.url : "",
    error: typeof value?.error === "string" ? value.error : "",
    logs,
  };
}

function readWechatProjectLabel(payload) {
  const target = Array.isArray(payload?.targets) ? payload.targets[0] : null;
  const label = typeof target?.label === "string" ? target.label : "";
  const appId = typeof target?.appId === "string" ? target.appId : "";
  return label || appId || (currentId ? "整个应用" : "请选择项目");
}

function renderWechatTargets(payload = {}) {
  const projectLabel = $("wechat-project-label");
  if (projectLabel) projectLabel.title = readWechatProjectLabel(payload);
}

function renderWechatState(nextState = wechatState) {
  wechatState = readWechatState(nextState);
  const chip = $("wechat-state");
  if (chip) {
    const labels = { idle: "空闲", building: "构建中…", running: "运行中", error: "错误", stopped: "已停止" };
    const kind = wechatState.state === "running" ? "good" : wechatState.state === "error" ? "bad" : "";
    chip.textContent = labels[wechatState.state] || "空闲";
    chip.className = `meta-chip${kind ? ` ${kind}` : ""}`;
    const detail = wechatState.error || wechatState.logs.at(-1) || "";
    if (detail) chip.title = detail;
    else chip.removeAttribute("title");
    chip.setAttribute("aria-label", `微信${chip.textContent}${detail ? `：${detail}` : ""}`);
  }
  renderWechatPreview();
  updateActionStates();
}

function renderWechatPreview() {
  if (!wechatPreviewPane || !wechatPreviewFrame || !wechatPreviewEmpty) return;
  const state = wechatState.state;
  const visible = state === "building" || state === "running" || state === "error";
  wechatPreviewPane.hidden = !visible;
  previewSurfaces?.classList.toggle("wechat-visible", visible);
  if (!visible) wechatPreviewPane.style.removeProperty("width");
  if (state === "running" && wechatState.url) {
    const url = wechatState.url;
    if (wechatPreviewFrame.dataset.url !== url) {
      wechatPreviewFrame.dataset.url = url;
      const embedded = new URL(url, window.location.href);
      embedded.pathname = "/pocket-embed";
      wechatPreviewFrame.src = embedded.href;
    }
    wechatPreviewFrame.hidden = false;
    wechatPreviewEmpty.hidden = true;
    return;
  }
  wechatPreviewFrame.hidden = true;
  wechatPreviewEmpty.hidden = false;
  if (state === "error") {
    wechatPreviewEmpty.querySelector("strong").textContent = "微信预览失败";
    wechatPreviewEmpty.querySelector("span").textContent = wechatState.error || "请查看微信运行日志。";
  } else if (state === "building") {
    wechatPreviewEmpty.querySelector("strong").textContent = "正在启动微信预览";
    wechatPreviewEmpty.querySelector("span").textContent = "正在构建整个应用…";
  } else {
    wechatPreviewEmpty.querySelector("strong").textContent = "微信预览";
    wechatPreviewEmpty.querySelector("span").textContent = "运行微信以加载整个应用。";
  }
  if (!visible || state === "error" || state === "building") {
    wechatPreviewFrame.dataset.url = "";
    if (wechatPreviewFrame.src !== "about:blank") wechatPreviewFrame.src = "about:blank";
  }
  layoutPreviewFrame();
}

function stopWechatPolling() {
  if (wechatPollTimer) clearTimeout(wechatPollTimer);
  wechatPollTimer = null;
}

function invalidateWechatRequests() {
  wechatGeneration += 1;
  stopWechatPolling();
  startingWechat = false;
  stoppingWechat = false;
}

function resetWechatPresentation() {
  wechatState = { state: "idle", url: "", error: "", logs: [] };
  renderWechatTargets();
  renderWechatState();
}

async function loadWechat(projectId, generation) {
  try {
    const response = await api(wechatPath(projectId));
    if (currentId !== projectId || generation !== wechatGeneration) return;
    renderWechatTargets(response);
    renderWechatState(response);
    if (wechatState.state === "building") void pollWechat(0, projectId, generation);
  } catch (error) {
    if (currentId !== projectId || generation !== wechatGeneration) return;
    renderWechatTargets();
    renderWechatState({ state: "error", error: normalizeError(error).message, logs: [] });
    showNotice(error);
  }
}

async function pollWechat(attempt = 0, projectId = currentId, generation = wechatGeneration) {
  if (!projectId || currentId !== projectId || generation !== wechatGeneration) return;
  wechatPollTimer = null;
  if (attempt > MAX_WECHAT_POLL_ATTEMPTS) {
    renderWechatState({ ...wechatState, state: "error", error: "微信验证超时。" });
    showNotice("微信验证超时。");
    return;
  }
  try {
    const response = await api(wechatPath(projectId));
    if (currentId !== projectId || generation !== wechatGeneration) return;
    renderWechatTargets(response);
    renderWechatState(response);
    if (wechatState.state === "building") {
      wechatPollTimer = setTimeout(() => void pollWechat(attempt + 1, projectId, generation), POLL_DELAY_MS);
    } else if (wechatState.state === "error" && wechatState.error) {
      showNotice(wechatState.error);
    }
  } catch (error) {
    if (currentId !== projectId || generation !== wechatGeneration) return;
    stopWechatPolling();
    renderWechatState({ ...wechatState, state: "error", error: normalizeError(error).message });
    showNotice(error);
  }
}

async function startWechat() {
  const projectId = currentId;
  const generation = wechatGeneration;
  const targetId = "main";
  if (!projectId || startingWechat || stoppingWechat || wechatState.state === "building" || wechatState.state === "running") return;
  clearNotice();
  startingWechat = true;
  renderWechatState({ state: "building", logs: [] });
  try {
    const response = await api(wechatPath(projectId), {
      method: "POST",
      body: JSON.stringify({ targetId }),
    });
    if (currentId !== projectId || generation !== wechatGeneration) return;
    renderWechatTargets(response);
    renderWechatState(response);
    if (wechatState.state === "building") void pollWechat(0, projectId, generation);
  } catch (error) {
    if (currentId !== projectId || generation !== wechatGeneration) return;
    renderWechatState({ state: "error", error: normalizeError(error).message, logs: [] });
    showNotice(error);
  } finally {
    if (currentId === projectId && generation === wechatGeneration) {
      startingWechat = false;
      updateActionStates();
    }
  }
}

async function stopWechat() {
  const projectId = currentId;
  if (!projectId || stoppingWechat || !["building", "running"].includes(wechatState.state)) return;
  const generation = ++wechatGeneration;
  clearNotice();
  stopWechatPolling();
  stoppingWechat = true;
  updateActionStates();
  try {
    const response = await api(wechatPath(projectId), { method: "DELETE" });
    if (currentId !== projectId || generation !== wechatGeneration) return;
    renderWechatState(response);
    if (wechatState.state === "building") void pollWechat(0, projectId, generation);
  } catch (error) {
    if (currentId !== projectId || generation !== wechatGeneration) return;
    showNotice(error);
  } finally {
    if (currentId === projectId && generation === wechatGeneration) {
      stoppingWechat = false;
      updateActionStates();
    }
  }
}

async function refreshFiles({ preserveDraft = dirty } = {}) {
  if (!currentId) return;
  const filesResponse = await api(`/api/projects/${encodeURIComponent(currentId)}/files`);
  const files = filesResponse.files || filesResponse;
  renderFilePicker(files);
  if (preserveDraft) {
    showNotice("服务器已刷新文件列表。当前未保存草稿仍然打开；再次点击“刷新文件”可丢弃草稿。", "info");
    return;
  }
  await loadFile(projectFiles.includes(currentFile) ? currentFile : projectFiles[0]);
}

function resourcesUrl(projectId) {
  return `/api/projects/${encodeURIComponent(projectId)}/resources`;
}

function unavailableResourceInventory(error = "") {
  return { revision: 0, packages: [], unavailable: true, error: error ? String(error) : "" };
}

const RESOURCE_BACKEND_OUTDATED_MESSAGE = "编辑器后端版本过旧，请重启编辑器服务并刷新页面。";

function sameOriginResourceUrl(value) {
  if (typeof value !== "string" || !value) return "";
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin || !["http:", "https:"].includes(url.protocol)) return "";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "";
  }
}

function normalizeResourceInventory(payload) {
  const packages = Array.isArray(payload?.packages) ? payload.packages : [];
  const seenPackages = new Set();
  return {
    revision: Number.isFinite(Number(payload?.revision)) ? Number(payload.revision) : 0,
    builtRevision: Number.isInteger(payload?.builtRevision) ? payload.builtRevision : undefined,
    unavailable: payload?.unavailable === true,
    error: typeof payload?.error === "string" ? payload.error : "",
    packages: packages.map((entry) => {
      const id = typeof entry?.id === "string" ? entry.id : "";
      if (!id || seenPackages.has(id)) return null;
      seenPackages.add(id);
      const seenResources = new Set();
      const resources = (Array.isArray(entry?.resources) ? entry.resources : []).map((resource) => {
        const key = typeof resource?.key === "string" ? resource.key : "";
        if (!key || seenResources.has(key)) return null;
        seenResources.add(key);
        const kind = resource?.kind === "asset" ? "asset" : "pak";
        const placement = resource?.placement === "network" ? "network" : "pak";
        const bytes = Number(resource?.bytes);
        return {
          key,
          kind,
          bytes: Number.isFinite(bytes) && bytes >= 0 ? bytes : null,
          placement,
          locked: resource?.locked === true,
          reason: typeof resource?.reason === "string" ? resource.reason : "",
          previewUrl: sameOriginResourceUrl(resource?.previewUrl),
        };
      }).filter(Boolean);
      return {
        id,
        title: typeof entry?.title === "string" && entry.title ? entry.title : id,
        manifest: typeof entry?.manifest === "string" ? entry.manifest : "",
        updateUrl: sameOriginResourceUrl(entry?.updateUrl),
        hostConfigUrl: sameOriginResourceUrl(entry?.hostConfigUrl),
        resources,
      };
    }).filter(Boolean),
  };
}

function copyResourceDraft(inventory) {
  const draft = new Map();
  for (const entry of inventory?.packages || []) {
    draft.set(entry.id, new Map(entry.resources.map((resource) => [resource.key, resource.placement])));
  }
  return draft;
}

function resourcePackage(packageId = resourcePackageId) {
  return resourceInventory?.packages.find((entry) => entry.id === packageId) || null;
}

function formatResourceBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "大小未知";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes >= 10 * 1024 ? 0 : 1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MiB`;
}

function isFontAtlasResource(resource) {
  return typeof resource?.key === "string" && /(?:^|:)ui:font\./.test(resource.key);
}

function resourceTypeLabel(resource) {
  return resource?.kind === "asset" ? "独立资源" : "PAK 资源";
}

function resourceFontSlot(resource) {
  const match = typeof resource?.key === "string" ? resource.key.match(/(?:^|:)ui:font\.(\d+)(?:$|[^\d])/i) : null;
  return match ? Number(match[1]) : null;
}

function compareResourceCards(left, right) {
  const previewOrder = Number(Boolean(right.previewUrl)) - Number(Boolean(left.previewUrl));
  if (previewOrder) return previewOrder;
  const leftSlot = resourceFontSlot(left);
  const rightSlot = resourceFontSlot(right);
  if (leftSlot !== null && rightSlot !== null && leftSlot !== rightSlot) return leftSlot - rightSlot;
  return String(left.key).localeCompare(String(right.key), undefined, { numeric: true, sensitivity: "base" });
}

function resourcePreviewPlaceholder(resource, unavailable = false) {
  const placeholder = document.createElement("div");
  placeholder.className = `resource-preview-placeholder${isFontAtlasResource(resource) ? " resource-preview-font" : ""}`;
  const icon = document.createElement("span");
  icon.className = "resource-preview-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = isFontAtlasResource(resource) ? "Aa" : "◇";
  const title = document.createElement("strong");
  title.textContent = isFontAtlasResource(resource)
    ? "已编译字形图集"
    : unavailable
      ? "预览不可用"
      : "没有图片预览";
  const detail = document.createElement("span");
  detail.textContent = isFontAtlasResource(resource)
    ? "不是独立字体文件"
    : `${resourceTypeLabel(resource)} · 未提供预览`;
  placeholder.append(icon, title, detail);
  return placeholder;
}

function resourcePreview(resource) {
  const preview = document.createElement("div");
  preview.className = "resource-preview";
  if (!resource.previewUrl) {
    preview.append(resourcePreviewPlaceholder(resource));
    return preview;
  }
  const image = document.createElement("img");
  image.className = "resource-preview-image";
  image.alt = `资源预览：${resource.key}`;
  image.loading = "lazy";
  image.decoding = "async";
  image.referrerPolicy = "no-referrer";
  image.src = resource.previewUrl;
  image.addEventListener("error", () => {
    preview.replaceChildren(resourcePreviewPlaceholder(resource, true));
  }, { once: true });
  preview.append(image);
  return preview;
}

function renderResourceState() {
  const state = $("resources-state");
  const saveStatus = $("resources-save-status");
  if (!state || !saveStatus) return;
  let label = "请选择项目";
  let kind = "";
  let detail = "尚未加载策略";
  if (currentId && resourcesLoading) {
    label = "加载中…";
    kind = "loading";
    detail = "正在加载资源包清单…";
  } else if (currentId && !resourceInventory) {
    label = "不可用";
    detail = "资源清单不可用";
  } else if (currentId && resourcesDirty) {
    label = "策略未保存";
    kind = "warn";
    detail = "资源策略未保存";
  } else if (currentId && currentStatus?.busy) {
    label = "构建中…";
    kind = "loading";
    detail = "正在构建";
  } else if (currentId && currentStatus?.error) {
    label = "构建失败";
    kind = "bad";
    detail = "构建失败，请查看诊断信息";
  } else if (currentId && resourceInventory?.unavailable) {
    label = resourceInventory.error ? "不可用" : "需要构建";
    kind = "warn";
    detail = resourceInventory.error || "构建后才能生成资源包清单";
  } else if (currentId && currentStatus && currentStatus.builtRevision !== currentStatus.revision) {
    label = "需要构建";
    kind = "warn";
    detail = "保存后再构建以应用此策略";
  } else if (currentId && resourceInventory) {
    label = resourceInventory.packages.some((entry) => entry.resources.length) ? "就绪" : "清单已就绪";
    kind = "good";
    detail = resourcesDirty ? "资源策略未保存" : "策略已保存";
  }
  state.textContent = label;
  state.className = `meta-chip${kind ? ` ${kind}` : ""}`;
  saveStatus.textContent = detail;
}

function resourcePackageHasDraftChanges(entry) {
  const draft = resourceDraft.get(entry?.id);
  return Boolean(entry?.resources.some((resource) => (draft?.get(resource.key) || resource.placement) !== resource.placement));
}

function hasResourceDraftChanges() {
  return Boolean(resourceInventory?.packages.some((entry) => resourcePackageHasDraftChanges(entry)));
}

function updateResourceActionStates(workLocked = false) {
  const hasProject = Boolean(currentId);
  const controlsLocked = !hasProject || resourcesLoading || workLocked;
  const picker = $("resource-package-picker");
  const save = $("save-resources");
  if (picker) picker.disabled = controlsLocked || !resourceInventory?.packages.length;
  if (save) save.disabled = controlsLocked || resourcesSaving || !resourcesDirty;
  for (const select of document.querySelectorAll("#resource-list select[data-resource-key]")) {
    select.disabled = controlsLocked || select.dataset.locked === "true";
  }
  renderResourcePackages();
}

function renderResourcePackages() {
  const list = $("resource-package-list");
  const count = $("resource-package-count");
  if (!list) return;
  const packages = resourceInventory?.packages || [];
  list.replaceChildren();
  if (count) count.textContent = packages.length ? `${packages.length} 个资源包` : "";
  if (!packages.length) {
    const empty = document.createElement("span");
    empty.className = "muted";
    empty.textContent = currentId && resourcesLoading
      ? "正在加载资源包…"
      : "请选择项目以查看资源包。";
    list.append(empty);
    return;
  }
  const controlsLocked = !currentId || resourcesLoading || resourcesSaving;
  for (const entry of packages) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "resource-package-button";
    button.dataset.resourcePackage = entry.id;
    button.dataset.packageId = entry.id;
    button.setAttribute("aria-pressed", String(entry.id === resourcePackageId));
    button.disabled = controlsLocked;
    button.title = `${entry.title} · ${entry.id}`;
    const title = document.createElement("strong");
    title.textContent = entry.title;
    const id = document.createElement("code");
    id.textContent = entry.id;
    const details = document.createElement("span");
    details.className = "resource-package-button-meta";
    details.textContent = `${entry.resources.length} 个资源`;
    button.append(title, id, details);
    button.addEventListener("click", () => { selectResourcePackage(entry.id); });
    list.append(button);
  }
}

function selectResourcePackage(nextPackage) {
  if (!resourceInventory?.packages.some((entry) => entry.id === nextPackage)) return false;
  const currentEntry = resourcePackage();
  if (resourcePackageId !== nextPackage && resourcesDirty && resourcePackageHasDraftChanges(currentEntry)) {
    const picker = $("resource-package-picker");
    if (picker) picker.value = resourcePackageId;
    renderResourcePackages();
    showNotice("切换资源包前请先保存当前资源策略。", "info");
    return false;
  }
  resourcePackageId = nextPackage;
  const picker = $("resource-package-picker");
  if (picker) picker.value = nextPackage;
  renderResourcePackages();
  renderResourcePackage();
  updateResourceActionStates();
  return true;
}

function renderResourcePackage() {
  const list = $("resource-list");
  const meta = $("resource-package-meta");
  if (!list || !meta) return;
  list.replaceChildren();
  const entry = resourcePackage();
  const title = $("resource-detail-title");
  if (!entry) {
    if (title) title.textContent = resourceInventory?.unavailable ? "资源包清单不可用" : "请选择资源包";
    meta.textContent = "";
    const empty = document.createElement("div");
    empty.className = "resource-empty";
    empty.textContent = resourceInventory?.unavailable
      ? resourceInventory.error || "请先构建项目以生成 PAK 和签名网络资源清单。"
      : resourceInventory
        ? "清单中没有小应用资源包。"
        : "请选择项目以查看资源包。";
    list.append(empty);
    return;
  }
  if (title) {
    title.textContent = entry.title;
    title.title = entry.id;
  }
  const resourceCount = entry.resources.length;
  meta.replaceChildren();
  const summary = document.createElement("span");
  summary.textContent = [
    entry.manifest ? `清单 ${entry.manifest}` : "清单不可用",
    `${resourceCount} 个资源`,
  ].join(" · ");
  meta.append(summary);
  if (!resourceCount) {
    const empty = document.createElement("div");
    empty.className = "resource-empty";
    empty.textContent = resourceInventory?.builtRevision === undefined || resourceInventory?.unavailable
      ? resourceInventory?.error || "请先构建项目以生成此资源包的 PAK 和签名网络资源清单。"
      : "此资源包在当前构建中没有资源。";
    list.append(empty);
    return;
  }
  const draft = resourceDraft.get(entry.id) || new Map();
  resourceDraft.set(entry.id, draft);
  const resources = [...entry.resources].sort(compareResourceCards);
  for (const resource of resources) {
    const row = document.createElement("div");
    row.className = `resource-row${resource.locked ? " resource-locked" : ""}`;
    row.dataset.resourceKey = resource.key;
    row.setAttribute("role", "listitem");
    if (!resource.locked) row.append(resourcePreview(resource));
    const main = document.createElement("div");
    main.className = "resource-row-main";
    const key = document.createElement("code");
    key.className = "resource-row-key";
    key.textContent = resource.key;
    key.title = resource.key;
    const info = document.createElement("span");
    info.className = "resource-row-meta";
    info.textContent = `${resourceTypeLabel(resource)} · ${formatResourceBytes(resource.bytes)}`;
    main.append(key, info);
    if (isFontAtlasResource(resource)) {
      const fontNote = document.createElement("span");
      fontNote.className = "resource-font-note";
      fontNote.textContent = "类型 · 字形图集";
      fontNote.title = "ui:font.N 是已编译字形图集，不是独立字体文件。";
      main.append(fontNote);
    }
    if (resource.locked) {
      const required = document.createElement("span");
      required.className = "resource-required-badge";
      required.textContent = "基础包 · 必需";
      required.title = resource.reason || "资源包必需项，位置已锁定。";
      row.append(main, required);
    } else {
      const placement = document.createElement("label");
      placement.className = "resource-placement";
      const placementLabel = document.createElement("span");
      placementLabel.className = "resource-placement-hint";
      placementLabel.textContent = "交付方式";
      const picker = document.createElement("select");
      picker.dataset.resourceKey = resource.key;
      picker.dataset.locked = String(resource.locked);
      picker.setAttribute("aria-label", `资源交付方式：${resource.key}`);
      for (const [value, label] of [["pak", "基础包"], ["network", "网络"]]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        picker.append(option);
      }
      picker.value = draft.get(resource.key) || resource.placement;
      picker.addEventListener("change", () => {
        draft.set(resource.key, picker.value === "network" ? "network" : "pak");
        resourcesDirty = hasResourceDraftChanges();
        renderResourceState();
        updateActionStates();
      });
      placement.append(placementLabel, picker);
      row.append(main, placement);
    }
    list.append(row);
  }
}

function renderResourceInventory() {
  const picker = $("resource-package-picker");
  if (!picker) return;
  picker.replaceChildren();
  if (resourceInventory?.packages.length) {
    if (!resourceInventory.packages.some((entry) => entry.id === resourcePackageId)) resourcePackageId = resourceInventory.packages[0].id;
    for (const entry of resourceInventory.packages) {
      const option = document.createElement("option");
      option.value = entry.id;
      option.textContent = entry.title === entry.id ? entry.id : `${entry.title} · ${entry.id}`;
      picker.append(option);
    }
    picker.value = resourcePackageId;
  } else {
    resourcePackageId = "";
  }
  renderResourcePackages();
  renderResourcePackage();
  renderResourceState();
  updateResourceActionStates();
}

function setResourceInventory(payload) {
  const normalized = normalizeResourceInventory(payload);
  const selected = resourcePackageId;
  resourceInventory = normalized;
  resourcePackageId = normalized.packages.some((entry) => entry.id === selected) ? selected : (normalized.packages[0]?.id || "");
  resourceDraft = copyResourceDraft(normalized);
  resourcesDirty = false;
  renderResourceInventory();
}

async function fetchResources(projectId) {
  try {
    return await api(resourcesUrl(projectId));
  } catch (error) {
    if (error?.status === 404) return unavailableResourceInventory(RESOURCE_BACKEND_OUTDATED_MESSAGE);
    // Resource inventory is supplemental to source editing and preview. Keep
    // those workflows usable while an unbuilt/stale server reports the
    // inventory error inside this panel only.
    return unavailableResourceInventory(error?.message || "资源清单不可用。");
  }
}

async function loadResources(projectId = currentId) {
  if (!projectId) return null;
  const generation = ++resourcesGeneration;
  resourcesLoading = true;
  renderResourceState();
  updateActionStates();
  try {
    const payload = await fetchResources(projectId);
    if (currentId !== projectId || generation !== resourcesGeneration) return null;
    setResourceInventory(payload);
    return resourceInventory;
  } finally {
    if (currentId === projectId && generation === resourcesGeneration) {
      resourcesLoading = false;
      renderResourceState();
      updateActionStates();
    }
  }
}

function resetResources() {
  resourcesGeneration += 1;
  resourceInventory = null;
  resourcePackageId = "";
  resourceDraft = new Map();
  resourcesDirty = false;
  resourcesLoading = false;
  renderResourceInventory();
  renderResourceState();
  updateResourceActionStates();
}

async function saveResources() {
  if (!currentId || !resourceInventory || !resourcesDirty || resourcesSaving) return;
  const projectId = currentId;
  const generation = resourcesGeneration;
  const entry = resourcePackage();
  if (!entry) return;
  const draft = resourceDraft.get(entry.id) || new Map();
  resourcesSaving = true;
  setText("resources-save-status", "正在保存资源策略…");
  updateActionStates();
  try {
    const response = await api(resourcesUrl(projectId), {
      method: "PUT",
      body: JSON.stringify({
        revision: resourceInventory.revision,
        packageId: entry.id,
        placements: entry.resources.map((resource) => ({ key: resource.key, placement: draft.get(resource.key) || resource.placement })),
      }),
    });
    if (currentId !== projectId || generation !== resourcesGeneration) return;
    setResourceInventory(response);
    try { await refreshStatus(); } catch {}
    showNotice("资源策略已保存。请构建项目以应用。", "success");
  } catch (error) {
    if (error?.status === 409 || error?.status === 412) {
      try {
        if (currentId === projectId) {
          await loadResources(projectId);
          await refreshStatus();
        }
      } catch {}
      showNotice("服务器上的资源策略已变化。已加载最新清单，请检查后再保存。", "info");
      return;
    }
    showNotice(error);
    throw error;
  } finally {
    resourcesSaving = false;
    renderResourceState();
    updateActionStates();
    resumeDeferredStudioUpgrade();
  }
}

function versionHistoryEntries(snapshot) {
  const raw = Array.isArray(snapshot?.history) ? snapshot.history : [];
  return raw
    .filter((item) => item && typeof item === "object" && Array.isArray(item.packages))
    .map((item) => {
      const channel = String(item.channel || "release").toLowerCase();
      return {
        id: String(item.releaseId || item.id || "release"),
        version: typeof item.version === "string" ? item.version : "",
        build: Number.isSafeInteger(item.build) ? item.build : null,
        channel: channel === "test" ? "test" : "stable",
        slot: item.slot === "stable" ? "stable" : item.slot === "test" ? "test" : "",
        publishedAt: typeof item.publishedAt === "string" ? item.publishedAt : "",
        archiveUrl: typeof item.archiveUrl === "string" ? item.archiveUrl : "",
        appConfigUrl: typeof item.appConfigUrl === "string" ? item.appConfigUrl : "",
        packages: item.packages
          .filter((pkg) => pkg && typeof pkg === "object")
          .map((pkg) => ({
            id: String(pkg.id || "package"),
            version: typeof pkg.version === "string" ? pkg.version : "",
            build: Number.isSafeInteger(pkg.build) ? pkg.build : null,
          })),
        reusedPackages: Array.isArray(item.reusedPackages)
          ? item.reusedPackages.filter((pkg) => pkg && typeof pkg === "object").map((pkg) => ({
            id: String(pkg.id || "MiniApp"),
            version: typeof pkg.version === "string" ? pkg.version : "",
            build: Number.isSafeInteger(pkg.build) ? pkg.build : null,
            ownerProjectId: typeof pkg.ownerProjectId === "string" ? pkg.ownerProjectId : "",
            releaseId: typeof pkg.releaseId === "string" ? pkg.releaseId : "",
          }))
          : [],
      };
    });
}

function createArchiveDownloadControl(entry, label) {
  const hasArchive = Boolean(entry?.archiveUrl);
  const control = document.createElement(hasArchive ? "a" : "button");
  control.className = "version-download-icon";
  control.textContent = "↧";
  control.title = hasArchive ? `下载${label}完整包` : `${label}暂无已发布完整包`;
  control.setAttribute("aria-label", control.title);
  if (hasArchive) {
    control.href = entry.archiveUrl;
    control.download = "";
  } else {
    control.type = "button";
    control.disabled = true;
  }
  return control;
}

function versionIdentityLabel(label, entry) {
  return [
    label,
    entry?.version ? `v${entry.version}` : "",
    entry?.build !== null && entry?.build !== undefined ? `build ${entry.build}` : "",
  ].filter(Boolean).join(" ");
}

function slotReleaseEntry(slot, historyEntries) {
  const releaseId = typeof slot?.releaseId === "string" ? slot.releaseId : "";
  const version = typeof slot?.version === "string" ? slot.version : "";
  const build = Number.isSafeInteger(slot?.build) ? slot.build : null;
  return historyEntries.find((entry) => releaseId && entry.id === releaseId)
    || historyEntries.find((entry) => entry.slot === slot?.name
      && (!version || entry.version === version)
      && (build === null || entry.build === build));
}

function renderVersionHistory(snapshot) {
  const section = $("version-history");
  const list = $("version-history-list");
  const count = $("version-history-count");
  if (!section || !list || !count) return;
  list.replaceChildren();
  const entries = versionHistoryEntries(snapshot);
  count.textContent = entries.length ? `${entries.length} 个发布版本` : "没有历史记录";
  section.hidden = !snapshot || entries.length === 0;
  if (!entries.length) return;
  for (const entry of entries) {
    const item = document.createElement("article");
    item.className = "version-history-item";
    const main = document.createElement("div");
    main.className = "version-history-item-main";
    const title = document.createElement("div");
    title.className = "version-history-item-title";
    const id = document.createElement("strong");
    id.textContent = entry.id;
    id.title = entry.id;
    const identity = document.createElement("span");
    const channelLabel = entry.channel === "test" ? "测试" : entry.channel === "stable" ? "稳定版" : "发布";
    identity.textContent = [
      channelLabel,
      entry.version ? `v${entry.version}` : "",
      entry.build !== null ? `build ${entry.build}` : "",
    ].filter(Boolean).join(" · ");
    title.append(id, identity);
    const meta = document.createElement("span");
    meta.className = "version-history-item-meta";
    meta.textContent = entry.publishedAt ? `发布时间：${entry.publishedAt}` : "已发布版本";
    const packageSummary = document.createElement("div");
    packageSummary.className = "version-history-item-packages";
    packageSummary.textContent = [
      ...entry.packages.map((pkg) => [
        pkg.id,
        pkg.version ? `v${pkg.version}` : "",
        pkg.build !== null ? `build ${pkg.build}` : "",
      ].filter(Boolean).join(" · ")),
      ...entry.reusedPackages.map((pkg) => [
        `复用 MiniApp ${pkg.id}`,
        pkg.version ? `v${pkg.version}` : "",
        pkg.build !== null ? `build ${pkg.build}` : "",
        pkg.ownerProjectId ? `所属项目 ${pkg.ownerProjectId}` : "",
        pkg.releaseId ? `版本 ${pkg.releaseId}` : "",
      ].filter(Boolean).join(" · ")),
    ].join("；");
    main.append(title, meta, packageSummary);
    const links = document.createElement("div");
    links.className = "version-history-item-links";
    if (entry.appConfigUrl) {
      const configLink = document.createElement("a");
      configLink.href = entry.appConfigUrl;
      configLink.target = "_blank";
      configLink.rel = "noopener";
      configLink.textContent = "版本配置 ↗";
      links.append(configLink);
    }
    if (entry.archiveUrl) {
      links.append(createArchiveDownloadControl(entry, versionIdentityLabel(channelLabel, entry)));
    }
    item.append(main, links);
    list.append(item);
  }
}

async function copyVersionUrl(url, button, label) {
  let copied = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      copied = true;
    } else {
      const input = document.createElement("textarea");
      input.value = url;
      input.setAttribute("readonly", "");
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.append(input);
      input.select();
      copied = document.execCommand("copy");
      input.remove();
    }
  } catch {}
  if (!copied) {
    showNotice(`无法复制 ${label}，请手动选择完整地址。`, "error");
    return;
  }
  const original = button.textContent;
  button.textContent = "已复制";
  button.setAttribute("aria-label", `${label}已复制`);
  showNotice(`${label}已复制。`, "success");
  setTimeout(() => {
    if (!button.isConnected) return;
    button.textContent = original;
    button.setAttribute("aria-label", `复制 ${label}`);
  }, 1800);
}

function renderVersionManagement() {
  const state = $("version-manager-state");
  const origin = $("version-backend-origin");
  const detail = $("version-backend-detail");
  const slots = $("version-slots");
  const appConfig = $("version-app-config");
  const appConfigLink = $("version-app-config-link");
  const appConfigCopy = $("version-app-config-copy");
  slots.replaceChildren();
  if (appConfig) appConfig.hidden = true;
  if (appConfigLink) {
    appConfigLink.removeAttribute("href");
    appConfigLink.textContent = "";
    appConfigLink.removeAttribute("title");
  }
  if (appConfigCopy) {
    appConfigCopy.disabled = true;
    appConfigCopy.textContent = "复制 App 接入地址";
    appConfigCopy.setAttribute("aria-label", "复制 App 接入地址");
  }
  if (!currentId) {
    cosSnapshot = null;
    cosFormProjectId = null;
    cfSnapshot = null;
    cfFormProjectId = null;
    cfTargetDrafts = [];
    cfMatrixDirty = false;
    renderCosPanel();
    renderCloudflarePanel();
    renderVersionHistory(null);
    state.textContent = "请选择项目";
    origin.textContent = "尚未启动";
    detail.textContent = "请选择项目以查看已发布版本。";
    slots.append(Object.assign(document.createElement("span"), { className: "muted", textContent: "尚未选择项目。" }));
    return;
  }
  if (versionsLoading) {
    renderCosPanel();
    renderCloudflarePanel();
    renderVersionHistory(null);
    state.textContent = "加载中…";
    detail.textContent = "正在启动或刷新只读版本服务。";
    slots.append(Object.assign(document.createElement("span"), { className: "muted", textContent: "正在加载版本槽…" }));
    return;
  }
  if (!versionSnapshot) {
    renderCosPanel();
    renderCloudflarePanel();
    renderVersionHistory(null);
    state.textContent = "打开后加载";
    origin.textContent = "尚未启动";
    detail.textContent = "打开此面板以启动只读版本服务。";
    slots.append(Object.assign(document.createElement("span"), { className: "muted", textContent: "发布测试版或稳定版包后会创建版本槽。" }));
    return;
  }
  if (versionSnapshot.cos && typeof versionSnapshot.cos === "object") {
    cosSnapshot = versionSnapshot.cos;
  }
  if (versionSnapshot.cloudflare && typeof versionSnapshot.cloudflare === "object") {
    cfSnapshot = versionSnapshot.cloudflare;
  }
  renderCosPanel();
  renderCloudflarePanel();
  origin.textContent = versionSnapshot.origin || "不可用";
  detail.textContent = versionSnapshot.error
    ? `局域网不可用：${versionSnapshot.error}。本机回环地址仍可用。`
    : `${versionSnapshot.lan ? "局域网" : "本机回环"} · 宿主 ${versionSnapshot.hostVersion || "editor"} · 仅签名产物`;
  const publishedCount = (versionSnapshot.slots || []).reduce((count, slot) => count + (slot.packages?.length || 0), 0);
  const historyCount = versionHistoryEntries(versionSnapshot).length;
  state.textContent = historyCount
    ? `${historyCount} 个已发布版本`
    : publishedCount ? `${publishedCount} 个资源包` : "没有版本";
  const appConfigUrl = typeof versionSnapshot.appConfigUrl === "string" ? versionSnapshot.appConfigUrl : "";
  if (appConfig && appConfigLink && appConfigCopy && appConfigUrl) {
    appConfig.hidden = false;
    appConfigLink.href = appConfigUrl;
    appConfigLink.textContent = appConfigUrl;
    appConfigLink.title = appConfigUrl;
    appConfigCopy.disabled = false;
  }
  const historyEntries = versionHistoryEntries(versionSnapshot);
  const rootAppId = $("config-app-id")?.value || "";
  for (const slot of versionSnapshot.slots || []) {
    const card = document.createElement("section");
    card.className = "version-slot";
    const heading = document.createElement("div");
    heading.className = "version-slot-heading";
    const title = document.createElement("strong");
    const slotLabel = slot.name === "test" ? "测试版" : slot.name === "stable" ? "稳定版" : slot.name;
    const rootPackage = (slot.packages || []).find((pkg) => rootAppId && pkg.id === rootAppId) || slot.packages?.[0];
    const slotVersion = typeof slot.version === "string" ? slot.version : rootPackage?.version;
    const slotBuild = Number.isSafeInteger(slot.build) ? slot.build : rootPackage?.build;
    title.textContent = [slotLabel, slotVersion ? `v${slotVersion}` : "", slotBuild !== undefined ? `构建 ${slotBuild}` : ""].filter(Boolean).join(" · ");
    const count = document.createElement("span");
    count.className = "meta-chip";
    const packageCount = slot.packages?.length || 0;
    const reusedPackageCount = slot.reusedPackages?.length || 0;
    count.textContent = reusedPackageCount
      ? `${packageCount} 个自有包 · ${reusedPackageCount} 个复用 MiniApp`
      : `${packageCount} 个资源包`;
    const headingActions = document.createElement("div");
    headingActions.className = "version-slot-heading-actions";
    headingActions.append(count);
    const currentEntry = slotReleaseEntry(slot, historyEntries);
    const archiveEntry = typeof slot.archiveUrl === "string" && slot.archiveUrl
      ? { ...(currentEntry || {}), archiveUrl: slot.archiveUrl, version: slotVersion || currentEntry?.version, build: slotBuild ?? currentEntry?.build }
      : currentEntry;
    headingActions.append(createArchiveDownloadControl(archiveEntry, versionIdentityLabel(slotLabel, archiveEntry || { version: slotVersion, build: slotBuild })));
    heading.append(title, headingActions);
    card.append(heading);
    if (!slot.packages?.length) {
      const slotLabel = slot.name === "test" ? "测试版" : slot.name === "stable" ? "稳定版" : slot.name;
      card.append(Object.assign(document.createElement("span"), { className: "muted", textContent: `尚未发布 ${slotLabel} 资源包。` }));
    }
    for (const pkg of slot.packages || []) {
      const item = document.createElement("div");
      item.className = "version-package";
      const packageTitle = document.createElement("div");
      packageTitle.className = "version-package-title";
      const id = document.createElement("strong");
      id.textContent = pkg.id;
      id.title = pkg.id;
      const identity = document.createElement("span");
      const role = rootAppId && pkg.id === rootAppId ? "主包" : "关联 mini app";
      identity.textContent = `${role} · v${pkg.version} · 构建 ${pkg.build}`;
      packageTitle.append(id, identity);
      item.append(packageTitle);
      card.append(item);
    }
    for (const pkg of slot.reusedPackages || []) {
      const item = document.createElement("div");
      item.className = "version-package";
      const packageTitle = document.createElement("div");
      packageTitle.className = "version-package-title";
      const id = document.createElement("strong");
      id.textContent = `MiniApp ${pkg.id}`;
      id.title = `MiniApp ${pkg.id}`;
      const identity = document.createElement("span");
      identity.textContent = [
        pkg.version ? `v${pkg.version}` : "",
        Number.isSafeInteger(pkg.build) ? `构建 ${pkg.build}` : "",
      ].filter(Boolean).join(" · ");
      packageTitle.append(id, identity);
      item.append(packageTitle);
      const owner = document.createElement("span");
      owner.className = "version-history-item-meta";
      owner.textContent = [
        pkg.ownerProjectId ? `所属项目 ${pkg.ownerProjectId}` : "",
        pkg.releaseId ? `已发布版本 ${pkg.releaseId}` : "",
      ].filter(Boolean).join(" · ");
      item.append(owner);
      card.append(item);
    }
    slots.append(card);
  }
  renderVersionHistory(versionSnapshot);
}

function cosSourceLabel(local) {
  if (!local || !local.available) return "未检测到本机密钥（可配置 ~/.cos.yaml、~/.cos.conf、环境变量或手动输入）";
  const masked = local.maskedSecretId ? ` · ${local.maskedSecretId}` : "";
  if (local.source === "coscli") return `已从 coscli (~/.cos.yaml) 加载${masked}`;
  if (local.source === "coscmd") return `已从 coscmd (~/.cos.conf) 加载${masked}`;
  if (local.source === "env") return `已从环境变量加载${masked}`;
  if (local.source === "workspace") return `已从 Studio 本机密钥库加载${masked}`;
  return `${local.sourceDetail || "已检测到本机密钥"}${masked}`;
}

function populateCosFormFromSnapshot(snapshot, force = false) {
  if (!snapshot || typeof snapshot !== "object") return;
  const cfg = snapshot.config || {};
  const local = snapshot.local || {};
  const defaultBucket = local.defaultBucket || {};
  if (force || cosFormProjectId !== currentId) {
    cosFormProjectId = currentId;
    if ($("cos-bucket")) $("cos-bucket").value = cfg.bucket || defaultBucket.bucket || "";
    if ($("cos-region")) $("cos-region").value = cfg.region || defaultBucket.region || "";
    if ($("cos-prefix")) $("cos-prefix").value = cfg.keyPrefix || "";
    if ($("cos-public-url")) $("cos-public-url").value = cfg.publicBaseUrl || "";
    if ($("cos-sync-on-publish")) $("cos-sync-on-publish").checked = Boolean(cfg.syncOnPublish);
  } else {
    if ($("cos-bucket") && !$("cos-bucket").value && (cfg.bucket || defaultBucket.bucket)) {
      $("cos-bucket").value = cfg.bucket || defaultBucket.bucket || "";
    }
    if ($("cos-region") && !$("cos-region").value && (cfg.region || defaultBucket.region)) {
      $("cos-region").value = cfg.region || defaultBucket.region || "";
    }
  }
}

function renderCosPanel() {
  const panel = $("version-cos-panel");
  if (!panel) return;
  const badge = $("version-cos-badge");
  const sourceEl = $("version-cos-source");
  const settingsEl = $("version-cos-settings");
  const toggleBtn = $("cos-toggle-settings");
  const enabledInput = $("cos-enabled");
  const presetRow = $("cos-bucket-preset-row");
  const presetSelect = $("cos-bucket-preset");
  const clearCredBtn = $("cos-clear-credentials");
  const activeArea = $("version-cos-active");
  const cosAppConfig = $("version-cos-app-config");
  const cosAppConfigLink = $("version-cos-app-config-link");
  const cosAppConfigCopy = $("version-cos-app-config-copy");
  const cosPublishMeta = $("version-cos-publish-meta");

  const snap = cosSnapshot || versionSnapshot?.cos || null;
  const local = snap?.local || { available: false, source: "none", discoveredBuckets: [] };
  const cfg = snap?.config || { enabled: false, syncOnPublish: false, bucket: "", region: "", keyPrefix: "", publicBaseUrl: "" };
  const published = snap?.published || {};

  if (!currentId) {
    if (badge) {
      badge.textContent = "未检测";
      badge.className = "meta-chip";
    }
    if (sourceEl) sourceEl.textContent = "自动检查 ~/.cos.yaml、~/.cos.conf、环境变量或本机密钥";
    if (enabledInput) enabledInput.checked = false;
    if (settingsEl) settingsEl.hidden = true;
    if (toggleBtn) toggleBtn.setAttribute("aria-expanded", "false");
    if (activeArea) activeArea.hidden = true;
    updateCosActionStates();
    return;
  }

  populateCosFormFromSnapshot(snap, false);

  if (badge) {
    if (cfg.enabled && local.available) {
      badge.textContent = "已开启";
      badge.className = "meta-chip good";
    } else if (local.available) {
      badge.textContent = "已检测到";
      badge.className = "meta-chip good";
    } else {
      badge.textContent = "未配置密钥";
      badge.className = "meta-chip";
    }
  }

  if (sourceEl) {
    const targetInfo = cfg.bucket && cfg.region ? ` · 存储桶 ${cfg.bucket} (${cfg.region})` : "";
    sourceEl.textContent = `${cosSourceLabel(local)}${targetInfo}`;
  }

  if (enabledInput) {
    enabledInput.checked = Boolean(cfg.enabled);
  }

  if (settingsEl) {
    settingsEl.hidden = !cosSettingsOpen;
  }
  if (toggleBtn) {
    toggleBtn.setAttribute("aria-expanded", String(cosSettingsOpen));
  }

  const buckets = Array.isArray(local.discoveredBuckets) ? local.discoveredBuckets : [];
  if (presetRow && presetSelect) {
    presetSelect.replaceChildren();
    if (buckets.length > 0) {
      presetRow.hidden = false;
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = `选择已发现存储桶 (${buckets.length})…`;
      presetSelect.append(placeholder);
      for (const b of buckets) {
        const opt = document.createElement("option");
        opt.value = `${b.bucket}@${b.region}`;
        opt.textContent = `${b.alias ? `${b.alias} · ` : ""}${b.bucket} (${b.region})`;
        presetSelect.append(opt);
      }
      const curBucket = $("cos-bucket")?.value?.trim() || cfg.bucket || "";
      const curRegion = $("cos-region")?.value?.trim() || cfg.region || "";
      const matchingVal = `${curBucket}@${curRegion}`;
      if ([...presetSelect.options].some((o) => o.value === matchingVal)) {
        presetSelect.value = matchingVal;
      }
    } else {
      presetRow.hidden = true;
    }
  }

  if (clearCredBtn) {
    clearCredBtn.hidden = local.source !== "workspace";
  }

  if (activeArea) {
    activeArea.hidden = !cfg.enabled;
  }

  const latestPublished = published.test && published.stable
    ? (String(published.test.publishedAt || "") >= String(published.stable.publishedAt || "") ? published.test : published.stable)
    : (published.test || published.stable || null);

  if (cosAppConfig && cosAppConfigLink && cosAppConfigCopy) {
    if (latestPublished && typeof latestPublished.appConfigUrl === "string" && latestPublished.appConfigUrl) {
      cosAppConfig.hidden = false;
      cosAppConfigLink.href = latestPublished.appConfigUrl;
      cosAppConfigLink.textContent = latestPublished.appConfigUrl;
      cosAppConfigLink.title = latestPublished.appConfigUrl;
      cosAppConfigCopy.disabled = false;
      if (cosPublishMeta) {
        const slotLabel = latestPublished.slot === "test" ? "测试版" : "稳定版";
        cosPublishMeta.textContent = `${slotLabel} v${latestPublished.version} · build ${latestPublished.build} · 上传 ${latestPublished.uploadedFiles} 个文件 / 复用 ${latestPublished.skippedFiles} 个文件`;
      }
    } else {
      cosAppConfig.hidden = true;
      cosAppConfigLink.removeAttribute("href");
      cosAppConfigLink.textContent = "";
      cosAppConfigCopy.disabled = true;
      if (cosPublishMeta) cosPublishMeta.textContent = "";
    }
  }

  updateCosActionStates();
}

function updateCosActionStates(workLocked = false) {
  const hasProject = Boolean(currentId);
  const locked = !hasProject || workLocked || cosBusy || versionsLoading;
  if ($("cos-detect")) $("cos-detect").disabled = locked;
  if ($("cos-toggle-settings")) $("cos-toggle-settings").disabled = !hasProject || cosBusy;
  if ($("cos-enabled")) $("cos-enabled").disabled = locked;
  if ($("cos-check-connection")) $("cos-check-connection").disabled = locked;
  if ($("cos-save-config")) $("cos-save-config").disabled = locked;
  if ($("cos-clear-credentials")) $("cos-clear-credentials").disabled = locked;

  const snap = cosSnapshot || versionSnapshot?.cos || null;
  const cosEnabled = Boolean(snap?.config?.enabled);
  const slots = Array.isArray(versionSnapshot?.slots) ? versionSnapshot.slots : [];
  const hasLocalTest = slots.some((s) => s.name === "test" && s.packages?.length > 0)
    || Boolean(currentStatus?.publish?.channel === "test");
  const hasLocalStable = slots.some((s) => s.name === "stable" && s.packages?.length > 0)
    || Boolean(currentStatus?.publish?.channel === "release");

  if ($("cos-publish-test")) {
    $("cos-publish-test").disabled = locked || !cosEnabled || !hasLocalTest;
  }
  if ($("cos-publish-stable")) {
    $("cos-publish-stable").disabled = locked || !cosEnabled || !hasLocalStable;
  }
}

async function detectLocalCos() {
  if (!currentId || cosBusy) return;
  const projectId = currentId;
  clearNotice();
  cosBusy = true;
  updateActionStates();
  try {
    const snap = await api(`/api/projects/${encodeURIComponent(projectId)}/cos`);
    if (currentId !== projectId) return;
    cosSnapshot = snap;
    if (versionSnapshot && typeof versionSnapshot === "object") {
      versionSnapshot.cos = snap;
    }
    populateCosFormFromSnapshot(snap, true);
    renderCosPanel();
    if (snap?.local?.available) {
      const bucketHint = snap.local.defaultBucket
        ? `，默认存储桶 ${snap.local.defaultBucket.bucket} (${snap.local.defaultBucket.region})`
        : "";
      showNotice(`已检测到 ${cosSourceLabel(snap.local)}${bucketHint}。`, "success");
    } else {
      cosSettingsOpen = true;
      renderCosPanel();
      showNotice("未检测到 ~/.cos.yaml、~/.cos.conf 或环境变量密钥，请在配置面板中填写密钥。", "info");
    }
  } catch (error) {
    if (currentId === projectId) showNotice(error);
  } finally {
    cosBusy = false;
    updateActionStates();
  }
}

function readCosFormFields() {
  const snap = cosSnapshot || versionSnapshot?.cos || null;
  const cfg = snap?.config || {};
  const defaultBucket = snap?.local?.defaultBucket || {};
  return {
    bucket: ($("cos-bucket")?.value ?? cfg.bucket ?? defaultBucket.bucket ?? "").trim(),
    region: ($("cos-region")?.value ?? cfg.region ?? defaultBucket.region ?? "").trim(),
    keyPrefix: ($("cos-prefix")?.value ?? cfg.keyPrefix ?? "").trim(),
    publicBaseUrl: ($("cos-public-url")?.value ?? cfg.publicBaseUrl ?? "").trim(),
    syncOnPublish: Boolean($("cos-sync-on-publish")?.checked),
  };
}

async function checkCosConnection() {
  if (!currentId || cosBusy) return;
  const projectId = currentId;
  clearNotice();
  cosBusy = true;
  updateActionStates();
  try {
    const fields = readCosFormFields();
    const res = await api(`/api/projects/${encodeURIComponent(projectId)}/cos/check`, {
      method: "POST",
      body: JSON.stringify({
        bucket: fields.bucket,
        region: fields.region,
        keyPrefix: fields.keyPrefix,
        publicBaseUrl: fields.publicBaseUrl,
      }),
    });
    if (currentId !== projectId) return;
    showNotice(`腾讯云 COS 连接验证成功：${res.bucket} (${res.region})。`, "success");
  } catch (error) {
    if (currentId === projectId) showNotice(error);
  } finally {
    cosBusy = false;
    updateActionStates();
  }
}

async function saveCosConfig(overrides = {}) {
  if (!currentId || cosBusy) return null;
  const projectId = currentId;
  clearNotice();
  cosBusy = true;
  updateActionStates();
  try {
    const fields = readCosFormFields();
    const secretId = ($("cos-secret-id")?.value ?? "").trim();
    const secretKey = ($("cos-secret-key")?.value ?? "").trim();
    const securityToken = ($("cos-security-token")?.value ?? "").trim();
    const payload = {
      enabled: overrides.enabled !== undefined ? Boolean(overrides.enabled) : Boolean($("cos-enabled")?.checked),
      syncOnPublish: fields.syncOnPublish,
      bucket: fields.bucket,
      region: fields.region,
      keyPrefix: fields.keyPrefix,
      publicBaseUrl: fields.publicBaseUrl,
      ...overrides,
    };
    if (overrides.credentials === undefined && (secretId || secretKey)) {
      payload.credentials = {
        secretId,
        secretKey,
        ...(securityToken ? { securityToken } : {}),
      };
    }
    const snap = await api(`/api/projects/${encodeURIComponent(projectId)}/cos`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    if (currentId !== projectId) return null;
    if ($("cos-secret-id")) $("cos-secret-id").value = "";
    if ($("cos-secret-key")) $("cos-secret-key").value = "";
    if ($("cos-security-token")) $("cos-security-token").value = "";
    cosSnapshot = snap;
    if (versionSnapshot && typeof versionSnapshot === "object") {
      versionSnapshot.cos = snap;
    }
    populateCosFormFromSnapshot(snap, true);
    renderCosPanel();
    return snap;
  } catch (error) {
    if (currentId === projectId) {
      renderCosPanel();
      showNotice(error);
    }
    return null;
  } finally {
    cosBusy = false;
    updateActionStates();
  }
}

async function publishToCos(channel) {
  if (!currentId || cosBusy || publishing) return;
  const projectId = currentId;
  clearNotice();
  cosBusy = true;
  updateActionStates();
  try {
    const res = await api(`/api/projects/${encodeURIComponent(projectId)}/cos/publish`, {
      method: "POST",
      body: JSON.stringify({ channel }),
    });
    if (currentId !== projectId) return;
    if (res.status) renderStatus(res.status);
    if (res.cos) {
      cosSnapshot = res.cos;
      if (versionSnapshot && typeof versionSnapshot === "object") {
        versionSnapshot.cos = res.cos;
      }
    }
    renderCosPanel();
    const sum = res.cosPublish;
    const label = channel === "release" ? "稳定版" : "测试版";
    showNotice(
      sum
        ? `已上传${label} v${sum.version} 到腾讯云 COS（上传 ${sum.uploadedFiles} 个文件，复用 ${sum.skippedFiles} 个文件）。`
        : `已上传${label}到腾讯云 COS。`,
      "success",
    );
  } catch (error) {
    if (currentId === projectId) showNotice(error);
  } finally {
    cosBusy = false;
    updateActionStates();
  }
}

const CF_PLATFORMS = ["*", "ios", "android", "macos", "windows", "linux", "web", "wechat"];
const CF_PLATFORM_LABELS = {
  "*": "全部 (*)",
  ios: "iOS",
  android: "Android",
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
  web: "Web",
  wechat: "微信",
};
const CF_ACCESS_KEY_FIELD = "access" + "KeyId";
const CF_SECRET_KEY_FIELD = "secret" + "AccessKey";
const CF_TOKEN_FIELD = "api" + "Token";
const CF_HAS_TOKEN_FIELD = "hasApi" + "Token";
const CF_MASKED_KEY_FIELD = "maskedAccess" + "KeyId";

const PACKAGE_CATEGORY_MATCHERS = {
  all: () => true,
  installed: (pkg) => Boolean(pkg.installed),
  "ui-skin": (pkg) => pkg.category === "ui-skin",
  "animation-game": (pkg) => pkg.category === "animation-game",
  "hardware-media": (pkg) => pkg.category === "hardware-media",
  "network-sync": (pkg) => pkg.category === "network-sync",
  "host-core": (pkg) => pkg.category === "host-core",
  "deploy-observability": (pkg) => pkg.category === "deploy-tooling" || pkg.category === "observability",
};

function cloneCloudflareTargetDraft(target = {}) {
  const validPlatforms = Array.isArray(target.platforms)
    ? target.platforms.filter((item) => CF_PLATFORMS.includes(item))
    : [];
  return {
    profileId: String(target.profileId || ""),
    accountId: String(target.accountId || ""),
    bucket: String(target.bucket || ""),
    endpoint: String(target.endpoint || ""),
    keyPrefix: String(target.keyPrefix || ""),
    publicBaseUrl: String(target.publicBaseUrl || ""),
    platforms: validPlatforms.length > 0 ? [...validPlatforms] : ["*"],
    role: target.role === "fallback" ? "fallback" : "primary",
    zoneId: String(target.zoneId || ""),
  };
}

function collectCloudflareTargetsPayload() {
  return cfTargetDrafts
    .filter((row) => row.profileId.trim() || row.bucket.trim() || row.publicBaseUrl.trim())
    .map((row) => ({
      profileId: row.profileId.trim(),
      ...(row.accountId.trim() ? { accountId: row.accountId.trim() } : {}),
      bucket: row.bucket.trim(),
      ...(row.endpoint.trim() ? { endpoint: row.endpoint.trim() } : {}),
      ...(row.keyPrefix.trim() ? { keyPrefix: row.keyPrefix.trim() } : {}),
      publicBaseUrl: row.publicBaseUrl.trim(),
      platforms: Array.isArray(row.platforms) && row.platforms.length > 0 ? [...row.platforms] : ["*"],
      role: row.role === "fallback" ? "fallback" : "primary",
      ...(row.zoneId.trim() ? { zoneId: row.zoneId.trim() } : {}),
    }));
}

function syncCloudflareFormFromSnapshot(force = false) {
  if (!cfSnapshot || !currentId) return;
  if (!force && cfFormProjectId === currentId) return;
  cfFormProjectId = currentId;
  cfMatrixDirty = false;
  const cfg = cfSnapshot.config || {};
  if ($("cf-sync-on-publish")) $("cf-sync-on-publish").checked = cfg.syncOnPublish === true;
  if ($("cf-purge-on-publish")) $("cf-purge-on-publish").checked = cfg.purgeCacheOnPublish !== false;
  const savedTargets = Array.isArray(cfg.targets) ? cfg.targets : [];
  if (savedTargets.length > 0) {
    cfTargetDrafts = savedTargets.map((item) => cloneCloudflareTargetDraft(item));
  } else {
    const firstProfile = cfSnapshot.local?.profiles?.[0];
    cfTargetDrafts = [
      cloneCloudflareTargetDraft({
        profileId: firstProfile?.profileId || "",
        accountId: firstProfile?.accountId || "",
        keyPrefix: `apps/${currentId}`,
        platforms: ["*"],
        role: "primary",
      }),
    ];
  }
}

function updateCloudflareActionStates(workLocked = false) {
  const locked = Boolean(workLocked || cfBusy || !currentId);
  for (const id of [
    "cf-detect",
    "cf-toggle-settings",
    "cf-enabled",
    "cf-sync-on-publish",
    "cf-purge-on-publish",
    "cf-profile-id",
    "cf-account-id",
    "cf-profile-label",
    "cf-access-key-id",
    "cf-secret-access-key",
    "cf-api-token",
    "cf-save-profile",
    "cf-add-target",
    "cf-save-config",
  ]) {
    if ($(id)) $(id).disabled = locked;
  }
  const slots = Array.isArray(versionSnapshot?.slots) ? versionSnapshot.slots : [];
  const hasTestSlot = slots.some((s) => s.name === "test" && s.packages?.length > 0)
    || Boolean(currentStatus?.publish?.channel === "test");
  const hasStableSlot = slots.some((s) => s.name === "stable" && s.packages?.length > 0)
    || Boolean(currentStatus?.publish?.channel === "release");
  const cfEnabled = Boolean(cfSnapshot?.config?.enabled);
  if ($("cf-publish-test")) {
    $("cf-publish-test").disabled = locked || !cfEnabled || !hasTestSlot;
  }
  if ($("cf-publish-stable")) {
    $("cf-publish-stable").disabled = locked || !cfEnabled || !hasStableSlot;
  }
  if ($("version-cf-app-config-copy")) {
    $("version-cf-app-config-copy").disabled = !currentId || !$("version-cf-app-config-link")?.getAttribute("href");
  }
  for (const el of document.querySelectorAll("#cf-targets-list input, #cf-targets-list select, #cf-targets-list button, #cf-profiles-list button")) {
    el.disabled = locked;
  }
}

function renderCloudflareProfilesList() {
  const container = $("cf-profiles-list");
  if (!container) return;
  container.replaceChildren();
  const profiles = Array.isArray(cfSnapshot?.local?.profiles) ? cfSnapshot.local.profiles : [];
  if (profiles.length === 0) {
    container.append(
      Object.assign(document.createElement("span"), {
        className: "muted",
        textContent: "尚未配置 Cloudflare 账户凭据，可在下方新增。",
      }),
    );
    return;
  }
  for (const profile of profiles) {
    const row = document.createElement("div");
    row.className = "cf-profile-item";
    row.dataset.profileId = profile.profileId;

    const info = document.createElement("div");
    info.className = "cf-profile-info";
    const title = document.createElement("strong");
    title.textContent = profile.label ? `${profile.profileId} (${profile.label})` : profile.profileId;
    const meta = document.createElement("span");
    meta.className = "muted";
    const sourceLabel = profile.source === "vault" ? "本地密钥库" : profile.source === "env" ? "环境变量" : "Wrangler";
    const parts = [
      profile.accountId ? `Account: ${profile.accountId}` : "未填 Account ID",
      profile[CF_MASKED_KEY_FIELD] ? `AK: ${profile[CF_MASKED_KEY_FIELD]}` : "",
      profile[CF_HAS_TOKEN_FIELD] ? "含 Zone Token" : "",
      sourceLabel,
    ].filter(Boolean);
    meta.textContent = parts.join(" · ");
    info.append(title, meta);

    const actions = document.createElement("div");
    actions.className = "cf-profile-actions";
    const fillBtn = document.createElement("button");
    fillBtn.type = "button";
    fillBtn.className = "ghost small";
    fillBtn.textContent = "编辑";
    fillBtn.addEventListener("click", () => {
      if ($("cf-profile-id")) $("cf-profile-id").value = profile.profileId || "";
      if ($("cf-account-id")) $("cf-account-id").value = profile.accountId || "";
      if ($("cf-profile-label")) $("cf-profile-label").value = profile.label || "";
    });
    actions.append(fillBtn);

    if (profile.source === "vault") {
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "ghost small";
      delBtn.dataset.cfDeleteProfile = profile.profileId;
      delBtn.textContent = "删除";
      delBtn.addEventListener("click", () => {
        void deleteCloudflareProfile(profile.profileId);
      });
      actions.append(delBtn);
    }

    row.append(info, actions);
    container.append(row);
  }
}

function renderCloudflareTargetsList() {
  const container = $("cf-targets-list");
  if (!container) return;
  container.replaceChildren();
  const profiles = Array.isArray(cfSnapshot?.local?.profiles) ? cfSnapshot.local.profiles : [];

  if (cfTargetDrafts.length === 0) {
    container.append(
      Object.assign(document.createElement("span"), {
        className: "muted",
        textContent: "尚未添加账户平台路由，点击「+ 添加账户路由」新增。",
      }),
    );
    return;
  }

  cfTargetDrafts.forEach((draft, index) => {
    const card = document.createElement("div");
    card.className = "cf-target-card";
    card.dataset.cfTargetIndex = String(index);
    card.dataset.role = draft.role === "fallback" ? "fallback" : "primary";

    const header = document.createElement("div");
    header.className = "cf-target-header";
    const title = document.createElement("strong");
    title.className = "cf-target-title";
    title.textContent = `路由 #${index + 1}`;
    const headerActions = document.createElement("div");
    headerActions.className = "cf-target-actions";

    const checkBtn = document.createElement("button");
    checkBtn.type = "button";
    checkBtn.className = "ghost small";
    checkBtn.dataset.cfCheckIndex = String(index);
    checkBtn.textContent = "验证连接";
    checkBtn.addEventListener("click", () => {
      void checkCloudflareTarget(index);
    });

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "ghost small";
    removeBtn.dataset.cfRemoveIndex = String(index);
    removeBtn.textContent = "删除";
    removeBtn.addEventListener("click", () => {
      cfTargetDrafts.splice(index, 1);
      cfMatrixDirty = true;
      renderCloudflareTargetsList();
      updateCloudflareActionStates();
    });

    headerActions.append(checkBtn, removeBtn);
    header.append(title, headerActions);

    const grid = document.createElement("div");
    grid.className = "cf-target-grid";

    const profileSelect = document.createElement("select");
    profileSelect.dataset.cfField = "profileId";
    if (profiles.length === 0 && !draft.profileId) {
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "请先在上方添加账户凭据";
      profileSelect.append(placeholder);
    } else {
      const emptyOpt = document.createElement("option");
      emptyOpt.value = "";
      emptyOpt.textContent = "选择 Cloudflare 账户";
      profileSelect.append(emptyOpt);
    }
    const seenIds = new Set();
    for (const p of profiles) {
      seenIds.add(p.profileId);
      const opt = document.createElement("option");
      opt.value = p.profileId;
      opt.textContent = p.label ? `${p.profileId} (${p.label})` : p.profileId;
      profileSelect.append(opt);
    }
    if (draft.profileId && !seenIds.has(draft.profileId)) {
      const customOpt = document.createElement("option");
      customOpt.value = draft.profileId;
      customOpt.textContent = `${draft.profileId} (未检测凭据)`;
      profileSelect.append(customOpt);
    }
    if (!draft.profileId && profiles.length > 0) {
      draft.profileId = profiles[0].profileId;
      draft.accountId = profiles[0].accountId || "";
    }
    profileSelect.value = draft.profileId;
    profileSelect.addEventListener("change", () => {
      draft.profileId = profileSelect.value;
      const matched = profiles.find((item) => item.profileId === draft.profileId);
      if (matched?.accountId) draft.accountId = matched.accountId;
      cfMatrixDirty = true;
    });

    const roleSelect = document.createElement("select");
    roleSelect.dataset.cfField = "role";
    for (const [val, text] of [
      ["primary", "主用路由 (primary)"],
      ["fallback", "备用容灾 (fallback)"],
    ]) {
      const opt = document.createElement("option");
      opt.value = val;
      opt.textContent = text;
      roleSelect.append(opt);
    }
    roleSelect.value = draft.role === "fallback" ? "fallback" : "primary";
    roleSelect.addEventListener("change", () => {
      draft.role = roleSelect.value === "fallback" ? "fallback" : "primary";
      cfMatrixDirty = true;
    });

    const bucketInput = Object.assign(document.createElement("input"), {
      type: "text",
      placeholder: "R2 Bucket 名称",
      value: draft.bucket,
    });
    bucketInput.dataset.cfField = "bucket";
    bucketInput.addEventListener("input", () => {
      draft.bucket = bucketInput.value;
      cfMatrixDirty = true;
    });

    const publicUrlInput = Object.assign(document.createElement("input"), {
      type: "url",
      placeholder: "公开访问域名 (HTTPS)",
      value: draft.publicBaseUrl,
    });
    publicUrlInput.dataset.cfField = "publicBaseUrl";
    publicUrlInput.addEventListener("input", () => {
      draft.publicBaseUrl = publicUrlInput.value;
      cfMatrixDirty = true;
    });

    const prefixInput = Object.assign(document.createElement("input"), {
      type: "text",
      placeholder: "对象前缀 (如 apps/demo)",
      value: draft.keyPrefix,
    });
    prefixInput.dataset.cfField = "keyPrefix";
    prefixInput.addEventListener("input", () => {
      draft.keyPrefix = prefixInput.value;
      cfMatrixDirty = true;
    });

    const zoneInput = Object.assign(document.createElement("input"), {
      type: "text",
      placeholder: "Zone ID (可选自动清缓存)",
      value: draft.zoneId,
    });
    zoneInput.dataset.cfField = "zoneId";
    zoneInput.addEventListener("input", () => {
      draft.zoneId = zoneInput.value;
      cfMatrixDirty = true;
    });

    grid.append(profileSelect, roleSelect, bucketInput, publicUrlInput, prefixInput, zoneInput);

    const pills = document.createElement("div");
    pills.className = "cf-platform-grid";
    const checkboxMap = new Map();

    const syncPlatformCheckboxes = () => {
      for (const [plat, box] of checkboxMap.entries()) {
        box.checked = draft.platforms.includes(plat);
      }
    };

    for (const plat of CF_PLATFORMS) {
      const pill = document.createElement("label");
      pill.className = "cf-platform-pill";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.dataset.cfPlatform = plat;
      box.checked = draft.platforms.includes(plat);
      checkboxMap.set(plat, box);
      box.addEventListener("change", () => {
        if (plat === "*" && box.checked) {
          draft.platforms = ["*"];
        } else {
          const next = new Set(draft.platforms.filter((item) => item !== "*"));
          if (box.checked) next.add(plat);
          else next.delete(plat);
          draft.platforms = next.size > 0 ? Array.from(next) : ["*"];
        }
        cfMatrixDirty = true;
        syncPlatformCheckboxes();
      });
      const text = document.createElement("span");
      text.textContent = CF_PLATFORM_LABELS[plat] || plat;
      pill.append(box, text);
      pills.append(pill);
    }

    card.append(header, grid, pills);
    container.append(card);
  });
}

function renderCloudflareTargetsSummary(summary) {
  const container = $("version-cf-targets-summary");
  if (!container) return;
  container.replaceChildren();
  const targets = Array.isArray(summary?.targets) ? summary.targets : [];
  container.hidden = targets.length === 0;
  for (const item of targets) {
    const row = document.createElement("div");
    row.className = "cf-published-target-row";
    const label = document.createElement("code");
    const roleTag = item.role === "fallback" ? "备用" : "主用";
    const plats = Array.isArray(item.platforms) ? item.platforms.join(", ") : "*";
    label.textContent = `[${roleTag}] ${item.profileId} / ${item.bucket} (${plats})`;
    const link = document.createElement("a");
    link.href = item.appConfigUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = item.appConfigUrl;
    row.append(label, link);
    container.append(row);
  }
}

function renderCloudflarePanel() {
  const badge = $("version-cf-badge");
  const source = $("version-cf-source");
  const enabledToggle = $("cf-enabled");
  const settingsBtn = $("cf-toggle-settings");
  const settings = $("version-cf-settings");
  const activeArea = $("version-cf-active");
  const appConfigBox = $("version-cf-app-config");
  const publishMeta = $("version-cf-publish-meta");
  const appConfigLink = $("version-cf-app-config-link");

  if (!badge || !source) return;
  if (settingsBtn) settingsBtn.setAttribute("aria-expanded", String(cfSettingsOpen));

  if (!currentId) {
    badge.className = "meta-chip";
    badge.textContent = "未选择项目";
    source.textContent = "请选择项目后配置 Cloudflare R2 多账户发布矩阵。";
    if (enabledToggle) enabledToggle.checked = false;
    if (settings) settings.hidden = true;
    if (activeArea) activeArea.hidden = true;
    if (appConfigBox) appConfigBox.hidden = true;
    updateCloudflareActionStates();
    return;
  }

  if (!cfSnapshot) {
    badge.className = "meta-chip";
    badge.textContent = "待加载";
    source.textContent = "打开版本面板或点击「检测账户」加载 Cloudflare 多账户凭据与路由矩阵。";
    if (enabledToggle) enabledToggle.checked = false;
    if (settings) settings.hidden = !cfSettingsOpen;
    if (activeArea) activeArea.hidden = true;
    if (appConfigBox) appConfigBox.hidden = true;
    updateCloudflareActionStates();
    return;
  }

  syncCloudflareFormFromSnapshot(false);
  renderCloudflareProfilesList();
  renderCloudflareTargetsList();

  const profiles = Array.isArray(cfSnapshot.local?.profiles) ? cfSnapshot.local.profiles : [];
  const targets = Array.isArray(cfSnapshot.config?.targets) ? cfSnapshot.config.targets : [];
  const isEnabled = Boolean(cfSnapshot.config?.enabled);

  if (isEnabled) {
    badge.className = "meta-chip ok";
    badge.textContent = `已启用 (${targets.length} 路由)`;
  } else if (profiles.length > 0) {
    badge.className = "meta-chip";
    badge.textContent = `已就绪 (${profiles.length} 账户)`;
  } else {
    badge.className = "meta-chip";
    badge.textContent = "未配置";
  }

  source.textContent = profiles.length > 0
    ? `已加载 ${profiles.length} 个 Cloudflare 账户凭据，当前配置 ${targets.length} 条平台路由。`
    : "未检测到本地 Cloudflare R2 凭据，请展开「配置」添加账户凭据与路由。";

  if (enabledToggle) enabledToggle.checked = isEnabled;
  if (settings) settings.hidden = !cfSettingsOpen;
  if (activeArea) activeArea.hidden = !isEnabled;

  const pubTest = cfSnapshot.published?.test;
  const pubStable = cfSnapshot.published?.stable;
  const latestPub = pubStable && pubTest
    ? (String(pubStable.publishedAt || "") >= String(pubTest.publishedAt || "") ? pubStable : pubTest)
    : (pubStable || pubTest || null);

  if (latestPub && appConfigBox && publishMeta && appConfigLink) {
    appConfigBox.hidden = false;
    const slotLabel = latestPub.slot === "stable" ? "稳定版" : "测试版";
    const purgeNote = latestPub.purgedZones > 0 ? ` · 已刷新 ${latestPub.purgedZones} 个 Zone 缓存` : "";
    publishMeta.textContent = `最近同步：${slotLabel} v${latestPub.version}（上传 ${latestPub.uploadedFiles}，复用 ${latestPub.skippedFiles}${purgeNote}）`;
    appConfigLink.href = latestPub.appConfigUrl;
    appConfigLink.textContent = latestPub.appConfigUrl;
    renderCloudflareTargetsSummary(latestPub);
  } else if (appConfigBox) {
    appConfigBox.hidden = true;
  }

  updateCloudflareActionStates();
}

async function loadCloudflareConfig({ notify = false } = {}) {
  if (!currentId) return;
  const projectId = currentId;
  cfBusy = true;
  updateActionStates();
  try {
    const snap = await api(`/api/projects/${encodeURIComponent(projectId)}/cloudflare`);
    if (currentId !== projectId) return;
    cfSnapshot = snap;
    if (versionSnapshot && typeof versionSnapshot === "object") {
      versionSnapshot.cloudflare = snap;
    }
    syncCloudflareFormFromSnapshot(true);
    renderCloudflarePanel();
    if (notify) {
      const count = Array.isArray(snap?.local?.profiles) ? snap.local.profiles.length : 0;
      showNotice(`已刷新 Cloudflare 配置（检测到 ${count} 个账户凭据）。`, "success");
    }
  } catch (error) {
    if (currentId === projectId && notify) showNotice(error);
  } finally {
    cfBusy = false;
    updateActionStates();
  }
}

async function saveCloudflareProfile() {
  if (!currentId || cfBusy) return;
  const projectId = currentId;
  const profileId = String($("cf-profile-id")?.value || "").trim();
  const accountId = String($("cf-account-id")?.value || "").trim();
  const label = String($("cf-profile-label")?.value || "").trim();
  const ak = String($("cf-access-key-id")?.value || "").trim();
  const sk = String($("cf-secret-access-key")?.value || "").trim();
  const tok = String($("cf-api-token")?.value || "").trim();

  if (!profileId || !accountId || !ak || !sk) {
    showNotice("请完整填写 Profile ID、Account ID、R2 Access Key ID 与 Secret Access Key。", "error");
    return;
  }

  clearNotice();
  cfBusy = true;
  updateActionStates();
  try {
    const upsertProfile = {
      profileId,
      accountId,
      ...(label ? { label } : {}),
      [CF_ACCESS_KEY_FIELD]: ak,
      [CF_SECRET_KEY_FIELD]: sk,
      ...(tok ? { [CF_TOKEN_FIELD]: tok } : {}),
    };
    const snap = await api(`/api/projects/${encodeURIComponent(projectId)}/cloudflare`, {
      method: "PUT",
      body: JSON.stringify({ upsertProfile }),
    });
    if (currentId !== projectId) return;
    cfSnapshot = snap;
    if (versionSnapshot && typeof versionSnapshot === "object") {
      versionSnapshot.cloudflare = snap;
    }
    if ($("cf-access-key-id")) $("cf-access-key-id").value = "";
    if ($("cf-secret-access-key")) $("cf-secret-access-key").value = "";
    if ($("cf-api-token")) $("cf-api-token").value = "";
    if (cfTargetDrafts.length > 0 && !cfTargetDrafts[0].profileId) {
      cfTargetDrafts[0].profileId = profileId;
      cfTargetDrafts[0].accountId = accountId;
    }
    renderCloudflarePanel();
    showNotice(`已保存 Cloudflare 账户凭据「${profileId}」（本地 0600 权限保护）。`, "success");
  } catch (error) {
    if (currentId === projectId) showNotice(error);
  } finally {
    cfBusy = false;
    updateActionStates();
  }
}

async function deleteCloudflareProfile(profileId) {
  if (!currentId || cfBusy || !profileId) return;
  const projectId = currentId;
  clearNotice();
  cfBusy = true;
  updateActionStates();
  try {
    const snap = await api(`/api/projects/${encodeURIComponent(projectId)}/cloudflare`, {
      method: "PUT",
      body: JSON.stringify({ removeProfileId: profileId }),
    });
    if (currentId !== projectId) return;
    cfSnapshot = snap;
    if (versionSnapshot && typeof versionSnapshot === "object") {
      versionSnapshot.cloudflare = snap;
    }
    renderCloudflarePanel();
    showNotice(`已移除 Cloudflare 账户凭据「${profileId}」。`, "success");
  } catch (error) {
    if (currentId === projectId) showNotice(error);
  } finally {
    cfBusy = false;
    updateActionStates();
  }
}

async function saveCloudflareMatrixConfig({ silent = false, overrideEnabled = null } = {}) {
  if (!currentId || cfBusy) return false;
  const projectId = currentId;
  const targets = collectCloudflareTargetsPayload();
  const enabled = overrideEnabled !== null ? Boolean(overrideEnabled) : Boolean($("cf-enabled")?.checked);
  const syncOnPublish = Boolean($("cf-sync-on-publish")?.checked);
  const purgeCacheOnPublish = $("cf-purge-on-publish") ? Boolean($("cf-purge-on-publish").checked) : true;

  if (enabled && targets.length === 0) {
    showNotice("启用 Cloudflare 发布前请至少填写一条完整的 R2 账户路由。", "error");
    if ($("cf-enabled")) $("cf-enabled").checked = false;
    return false;
  }

  if (!silent) clearNotice();
  cfBusy = true;
  updateActionStates();
  try {
    const snap = await api(`/api/projects/${encodeURIComponent(projectId)}/cloudflare`, {
      method: "PUT",
      body: JSON.stringify({
        enabled,
        syncOnPublish,
        purgeCacheOnPublish,
        targets,
      }),
    });
    if (currentId !== projectId) return false;
    cfSnapshot = snap;
    cfMatrixDirty = false;
    if (versionSnapshot && typeof versionSnapshot === "object") {
      versionSnapshot.cloudflare = snap;
    }
    syncCloudflareFormFromSnapshot(true);
    renderCloudflarePanel();
    if (!silent) {
      showNotice(
        `已保存 Cloudflare 多账户路由矩阵（共 ${targets.length} 条路由${enabled ? "，已启用发布" : ""}）。`,
        "success",
      );
    }
    return true;
  } catch (error) {
    if (currentId === projectId) {
      renderCloudflarePanel();
      showNotice(error);
    }
    return false;
  } finally {
    cfBusy = false;
    updateActionStates();
  }
}

async function checkCloudflareTarget(index) {
  if (!currentId || cfBusy) return;
  const projectId = currentId;
  const draft = cfTargetDrafts[index];
  if (!draft || !draft.profileId.trim() || !draft.bucket.trim()) {
    showNotice("验证连接前请先为该路由选择账户并填写 R2 Bucket 名称。", "error");
    return;
  }
  clearNotice();
  cfBusy = true;
  updateActionStates();
  try {
    const res = await api(`/api/projects/${encodeURIComponent(projectId)}/cloudflare/check`, {
      method: "POST",
      body: JSON.stringify({
        profileId: draft.profileId.trim(),
        ...(draft.accountId.trim() ? { accountId: draft.accountId.trim() } : {}),
        bucket: draft.bucket.trim(),
        ...(draft.keyPrefix.trim() ? { keyPrefix: draft.keyPrefix.trim() } : {}),
        ...(draft.publicBaseUrl.trim() ? { publicBaseUrl: draft.publicBaseUrl.trim() } : {}),
        ...(draft.endpoint.trim() ? { endpoint: draft.endpoint.trim() } : {}),
      }),
    });
    if (currentId !== projectId) return;
    showNotice(`Cloudflare R2 连接正常：${res.profileId} / ${res.bucket}`, "success");
  } catch (error) {
    if (currentId === projectId) showNotice(error);
  } finally {
    cfBusy = false;
    updateActionStates();
  }
}

async function publishToCloudflare(channel) {
  if (!currentId || cfBusy || publishing) return;
  const projectId = currentId;
  clearNotice();
  if (cfMatrixDirty) {
    const saved = await saveCloudflareMatrixConfig({ silent: true });
    if (!saved || currentId !== projectId) return;
  }
  cfBusy = true;
  updateActionStates();
  try {
    const res = await api(`/api/projects/${encodeURIComponent(projectId)}/cloudflare/publish`, {
      method: "POST",
      body: JSON.stringify({ channel }),
    });
    if (currentId !== projectId) return;
    if (res.status) renderStatus(res.status);
    if (res.cloudflare) {
      cfSnapshot = res.cloudflare;
      if (versionSnapshot && typeof versionSnapshot === "object") {
        versionSnapshot.cloudflare = res.cloudflare;
      }
    }
    renderCloudflarePanel();
    const sum = res.cloudflarePublish;
    const label = channel === "release" ? "稳定版" : "测试版";
    showNotice(
      sum
        ? `已同步${label} v${sum.version} 到 Cloudflare R2（${sum.targets?.length || 1} 条路由，上传 ${sum.uploadedFiles} 个文件，复用 ${sum.skippedFiles} 个文件）。`
        : `已同步${label}到 Cloudflare R2。`,
      "success",
    );
  } catch (error) {
    if (currentId === projectId) showNotice(error);
  } finally {
    cfBusy = false;
    updateActionStates();
  }
}

function updatePackagesActionStates(workLocked = false) {
  const locked = Boolean(workLocked || packagesBusy || !currentId);
  for (const id of ["open-packages-manager", "packages-search", "packages-refresh"]) {
    if ($(id)) $(id).disabled = locked;
  }
  for (const box of document.querySelectorAll("#packages-list input[data-package-toggle]")) {
    const coreLocked = box.dataset.coreLocked === "1";
    box.disabled = locked || coreLocked;
  }
}

const PACKAGE_CATEGORY_LABELS = [
  ["all", "全部"],
  ["installed", "已安装"],
  ["ui-skin", "UI 与皮肤"],
  ["animation-game", "动画与游戏"],
  ["hardware-media", "硬件与媒体"],
  ["network-sync", "网络与同步"],
  ["host-core", "宿主核心"],
  ["deploy-observability", "发布与诊断"],
];

function renderPackagesPanel() {
  const countBadge = $("packages-active-count");
  const categoryBar = $("packages-category-bar");
  const listEl = $("packages-list");
  if (!listEl) return;

  if (categoryBar) {
    if (categoryBar.childElementCount === 0) {
      for (const [catId, catLabel] of PACKAGE_CATEGORY_LABELS) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "packages-category-pill";
        btn.dataset.pkgCat = catId;
        btn.setAttribute("role", "tab");
        btn.textContent = catLabel;
        categoryBar.append(btn);
      }
    }
    for (const pill of categoryBar.querySelectorAll("[data-pkg-cat]")) {
      const isSelected = pill.getAttribute("data-pkg-cat") === packagesCategory;
      pill.classList.toggle("active", isSelected);
      pill.setAttribute("aria-selected", String(isSelected));
    }
  }

  listEl.replaceChildren();

  if (!currentId) {
    if (countBadge) countBadge.textContent = "已安装 0 / 0";
    listEl.append(
      Object.assign(document.createElement("span"), {
        className: "muted",
        textContent: "请选择项目以管理 PocketFlutter 官方包。",
      }),
    );
    updatePackagesActionStates();
    return;
  }

  if (!packagesSnapshot) {
    if (countBadge) countBadge.textContent = packagesBusy ? "加载中…" : "待加载";
    listEl.append(
      Object.assign(document.createElement("span"), {
        className: "muted",
        textContent: packagesBusy ? "正在读取官方包注册表与项目锁文件…" : "打开此面板以加载官方按需包。",
      }),
    );
    updatePackagesActionStates();
    return;
  }

  const allPackages = Array.isArray(packagesSnapshot.packages) ? packagesSnapshot.packages : [];
  const totalCount = packagesSnapshot.totalPackages ?? allPackages.length;
  const installedCount = packagesSnapshot.installedCount ?? allPackages.filter((pkg) => pkg.installed).length;
  if (countBadge) {
    countBadge.textContent = `已安装 ${installedCount} / ${totalCount}`;
  }

  const categoryMatch = PACKAGE_CATEGORY_MATCHERS[packagesCategory] || PACKAGE_CATEGORY_MATCHERS.all;
  const q = packagesQuery;
  const filtered = allPackages.filter((pkg) => {
    if (!categoryMatch(pkg)) return false;
    if (!q) return true;
    const haystack = [
      pkg.slug,
      pkg.jsPackageName,
      pkg.dartPackageName || "",
      pkg.description || "",
      ...(Array.isArray(pkg.shortAliases) ? pkg.shortAliases : []),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  });

  if (filtered.length === 0) {
    listEl.append(
      Object.assign(document.createElement("span"), {
        className: "muted",
        textContent: "没有匹配当前筛选条件的官方包。",
      }),
    );
    updatePackagesActionStates();
    return;
  }

  for (const pkg of filtered) {
    const card = document.createElement("div");
    card.className = `package-card${pkg.installed ? " installed" : ""}${pkg.coreLocked ? " core-locked" : ""}`;
    card.dataset.packageSlug = pkg.slug;
    card.setAttribute("role", "listitem");

    const main = document.createElement("div");
    main.className = "package-card-main";

    const header = document.createElement("div");
    header.className = "package-card-head";
    const title = document.createElement("strong");
    title.textContent = pkg.jsPackageName || pkg.slug;
    const versionTag = document.createElement("span");
    versionTag.className = "package-version-tag";
    versionTag.textContent = `v${pkg.version}`;

    const modeTag = document.createElement("span");
    modeTag.className = `package-mode-tag${pkg.requiresHostRebuild ? " native" : ""}`;
    modeTag.textContent = pkg.coreLocked
      ? "核心内置"
      : pkg.requiresHostRebuild
        ? "含原生宿主插件"
        : "纯 JS 即时生效";

    header.append(title, versionTag, modeTag);

    const desc = document.createElement("div");
    desc.className = "package-card-desc";
    desc.textContent = pkg.description || "";

    const meta = document.createElement("div");
    meta.className = "package-card-meta";
    const slugSpan = document.createElement("span");
    slugSpan.textContent = pkg.slug;
    meta.append(slugSpan);

    if (Array.isArray(pkg.platforms) && pkg.platforms.length > 0) {
      const platSpan = document.createElement("span");
      platSpan.textContent = `平台: ${pkg.platforms.join("/")}`;
      meta.append(platSpan);
    }
    if (Array.isArray(pkg.dependencies) && pkg.dependencies.length > 0) {
      const depSpan = document.createElement("span");
      depSpan.textContent = `依赖: ${pkg.dependencies.join(", ")}`;
      meta.append(depSpan);
    }

    main.append(header, desc, meta);

    const switchLabel = document.createElement("label");
    switchLabel.className = `package-switch${pkg.installed ? " installed" : ""}`;
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.dataset.packageToggle = pkg.slug;
    toggle.dataset.coreLocked = pkg.coreLocked ? "1" : "0";
    toggle.checked = Boolean(pkg.installed);
    toggle.disabled = Boolean(pkg.coreLocked || packagesBusy || !currentId);
    toggle.addEventListener("change", () => {
      void toggleProjectPackage(pkg.slug, toggle.checked);
    });
    const switchText = document.createElement("span");
    switchText.textContent = pkg.coreLocked ? "内置" : pkg.installed ? "已装" : "开启";
    switchLabel.append(toggle, switchText);

    card.append(main, switchLabel);
    listEl.append(card);
  }

  updatePackagesActionStates();
}

async function loadProjectPackages({ notify = false } = {}) {
  if (!currentId || packagesBusy) return;
  const projectId = currentId;
  packagesBusy = true;
  renderPackagesPanel();
  updateActionStates();
  try {
    const snap = await api(`/api/projects/${encodeURIComponent(projectId)}/packages`);
    if (currentId !== projectId) return;
    packagesSnapshot = snap;
    renderPackagesPanel();
    if (notify) {
      showNotice(`已同步官方包状态（已安装 ${snap.installedCount}/${snap.totalPackages}）。`, "success");
    }
  } catch (error) {
    if (currentId === projectId && notify) showNotice(error);
  } finally {
    packagesBusy = false;
    renderPackagesPanel();
    updateActionStates();
  }
}

async function toggleProjectPackage(slug, install) {
  if (!currentId || packagesBusy) return;
  const projectId = currentId;
  clearNotice();
  packagesBusy = true;
  updateActionStates();
  try {
    const res = await api(`/api/projects/${encodeURIComponent(projectId)}/packages`, {
      method: "POST",
      body: JSON.stringify({
        action: install ? "add" : "remove",
        packages: [slug],
      }),
    });
    if (currentId !== projectId) return;
    if (res.packagesSnapshot) {
      packagesSnapshot = res.packagesSnapshot;
    }
    if (res.status) {
      renderStatus(res.status);
    }
    try {
      const files = await api(`/api/projects/${encodeURIComponent(projectId)}/files`);
      if (currentId === projectId) {
        renderFilePicker(files.files || files);
      }
    } catch {
      // Non-fatal file picker refresh
    }
    renderPackagesPanel();
    const actionLabel = install ? "已安装" : "已卸载";
    const rebuildHint = res.requiresHostRebuild
      ? "（涉及原生 Flutter 插件变更，真机/模拟器运行前请重新构建宿主）"
      : "（纯 JS 包，保存或热重载即可直接使用）";
    showNotice(`${actionLabel}官方包「${slug}」${rebuildHint}`, "success");
  } catch (error) {
    if (currentId === projectId) {
      renderPackagesPanel();
      showNotice(error);
    }
  } finally {
    packagesBusy = false;
    updateActionStates();
  }
}

async function loadVersions() {
  if (!currentId || versionsLoading) return;
  const projectId = currentId;
  const generation = ++versionsGeneration;
  versionsLoading = true;
  renderVersionManagement();
  updateActionStates();
  try {
    const snapshot = await api(`/api/projects/${encodeURIComponent(projectId)}/versions`);
    if (currentId !== projectId || generation !== versionsGeneration) return;
    versionSnapshot = snapshot;
  } catch (error) {
    if (currentId === projectId && generation === versionsGeneration) {
      // A failed refresh must not leave a previous project's successful slots/history visible.
      versionSnapshot = null;
      showNotice(error);
    }
  } finally {
    if (currentId === projectId && generation === versionsGeneration) {
      versionsLoading = false;
      renderVersionManagement();
      updateActionStates();
    }
  }
}

function renderArtifacts(status) {
  const artifacts = $("artifacts");
  artifacts.replaceChildren();
  const runtimeAbi = $("runtime-abi");
  const publishInfo = $("publish-info");
  const publishStatus = $("publish-status");
  const testPublishInfo = $("test-publish-info");
  const publish = status?.publish;
  runtimeAbi.textContent = status?.publish?.runtimeAbi || "ABI —";
  publishInfo.replaceChildren();
  publishInfo.hidden = true;
  testPublishInfo.replaceChildren();
  testPublishInfo.hidden = true;
  if (!publish) {
    publishStatus.textContent = "尚未发布";
  } else {
    const channel = publish.channel === "test" ? "测试包" : "稳定版";
    const identity = [publish.version ? `v${publish.version}` : "", publish.build !== undefined ? `build ${publish.build}` : ""].filter(Boolean).join(" · ");
    publishStatus.textContent = `最近${channel}已就绪${identity ? ` · ${identity}` : ""} · 修订版 r${publish.revision ?? status.revision ?? "—"}`;
  }
  if (!status?.artifacts) {
    const empty = document.createElement("span");
    empty.className = "muted";
    empty.textContent = "完成真实 QuickJS 构建后，构建产物会显示在这里。";
    artifacts.append(empty);
    return;
  }
  const names = [
    ["app.qjbc", status.artifacts.bytecode],
    ["app.bytecode.json", status.artifacts.metadata],
    ["app.pak", status.artifacts.pak],
    ["guest-manifest.json", status.artifacts.manifest],
    ["app.js (inspection)", status.artifacts.appJs],
    ["build.json", status.artifacts.build],
  ];
  for (const [name, href] of names) {
    if (!href) continue;
    const link = document.createElement("a");
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener";
    const title = document.createElement("span");
    title.textContent = name;
    const download = document.createElement("small");
    download.textContent = "下载 ↗";
    link.append(title, download);
    artifacts.append(link);
  }
  if (publish) {
    const key = document.createElement("span");
    key.textContent = `密钥 ${publish.keyId || "本地"}`;
    publishInfo.append(key);
    if (publish.channel) {
      const channel = document.createElement("span");
      channel.textContent = publish.channel === "test" ? "频道：测试" : "频道：发布";
      publishInfo.append(channel);
    }
    if (publish.lanOrigin) {
      const lan = document.createElement("span");
      lan.textContent = `局域网 ${publish.lanOrigin}`;
      publishInfo.append(lan);
    }
    if (publish.version || publish.build !== undefined) {
      const identity = document.createElement("span");
      identity.textContent = [publish.version ? `v${publish.version}` : "", publish.build !== undefined ? `构建 ${publish.build}` : ""].filter(Boolean).join(" · ");
      publishInfo.append(identity);
    }
    const links = [
      ["下载 tar.gz ↗", publish.archiveUrl],
    ];
    for (const [label, href] of links) {
      if (!href) continue;
      const link = document.createElement("a");
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = label;
      publishInfo.append(link);
    }
    publishInfo.hidden = false;
    if (publish.channel === "test") {
      const heading = document.createElement("strong");
      heading.textContent = `测试包 ${publish.version ? `v${publish.version}` : ""}${publish.build !== undefined ? ` · 构建 ${publish.build}` : ""} 已就绪。`;
      const first = document.createElement("span");
      first.textContent = publish.lanOrigin
        ? `局域网版本服务：${publish.lanOrigin}。仅配置版本面板的固定 latest.json 接入地址，容器会自动读取最新版本及关联子包。`
        : "没有可用的局域网接口，因此此包通过本机回环地址提供，用于模拟器/桌面测试。";
      const second = document.createElement("span");
      second.textContent = "然后打开 Demo Host → 更新 → 检查 → 应用。后续测试包不需要重新构建 Flutter。";
      const caveat = document.createElement("span");
      caveat.textContent = "局域网只暴露签名资源包；编辑器 API、源文件和签名密钥仍仅限本机回环地址。";
      testPublishInfo.append(heading, first, second, caveat);
      testPublishInfo.hidden = false;
    }
  }
}

function renderStatus(status) {
  currentStatus = status || null;
  const publishTarget = activePublishTarget();
  if (publishTarget?.projectId === currentId && currentStatus) {
    publishTarget.revision = currentStatus.revision;
    publishTarget.builtRevision = currentStatus.builtRevision;
    publishTarget.busy = Boolean(currentStatus.busy);
    publishTarget.built = currentStatus.builtRevision === currentStatus.revision && !currentStatus.error;
    if (publishTarget.kind === "root") {
      publishTarget.version = $("config-version")?.value || publishTarget.version;
      publishTarget.build = Number($("config-build")?.value ?? publishTarget.build);
    }
    renderPublishTargetPicker();
  }
  setText("source-revision", `修订版 ${status?.revision ?? "—"}`);
  const state = $("build-state");
  if (!status) {
    state.textContent = "尚未构建";
    state.className = "meta-chip";
  } else if (status.busy) {
    state.textContent = `正在构建 r${status.revision}`;
    state.className = "meta-chip";
  } else if (status.error) {
    state.textContent = "构建失败";
    state.className = "meta-chip bad";
  } else if (status.builtRevision === status.revision) {
    state.textContent = `已构建 r${status.revision}`;
    state.className = "meta-chip good";
  } else {
    state.textContent = "修改尚未构建";
    state.className = "meta-chip";
  }
  logEl.textContent = status?.logs?.join("\n") || "暂无诊断信息。";
  logEl.scrollTop = logEl.scrollHeight;
  renderArtifacts(status);
  renderResourceState();
  if (!dirty) markDirty(false);
  else updateActionStates();
  maybeRefreshPreview(status);
}

async function refreshStatus(projectId = currentId) {
  if (!projectId) return null;
  const status = await api(`/api/projects/${encodeURIComponent(projectId)}/status`);
  if (currentId !== projectId) return null;
  renderStatus(status);
  return status;
}

function stopBuildPolling() {
  if (buildPollTimer) clearTimeout(buildPollTimer);
  buildPollTimer = null;
}

async function pollBuild(attempt = 0) {
  if (!currentId || attempt > MAX_BUILD_POLL_ATTEMPTS) {
    stopBuildPolling();
    return;
  }
  const projectId = currentId;
  try {
    const status = await refreshStatus(projectId);
    if (currentId !== projectId) return;
    if (status?.busy) {
      buildPollTimer = setTimeout(() => void pollBuild(attempt + 1), POLL_DELAY_MS);
    } else {
      stopBuildPolling();
      const config = await api(`/api/projects/${encodeURIComponent(projectId)}/config`);
      if (currentId !== projectId) return;
      applyProjectConfig(config, { preserveDraft: true });
      await refreshProjectList();
      if (currentId !== projectId) return;
      if (status?.builtRevision === status?.revision && !status?.error) {
        void loadResources(projectId).catch(showNotice);
      }
      void refreshPublishTargets();
    }
  } catch (error) {
    stopBuildPolling();
    showNotice(error);
  }
}

async function selectProject(id, options = {}) {
  if (currentId === id) return;
  if (saving || publishing || startingBuild || currentStatus?.busy || publishTargetsLoading) {
    showNotice("请先等待当前保存、构建、发布或目标刷新完成，再切换项目。", "info");
    return;
  }
  if (activeDeploy || startingDeploy) {
    showNotice("请先完成或取消当前部署，再切换项目。", "info");
    return;
  }
  if ((dirty || hasUnsavedProjectConfig() || resourcesDirty) && currentId !== id && !window.confirm("放弃未保存的源文件、配置或资源修改？")) return;
  clearNotice();
  publishTargetContext = options.publishTargetContext || null;
  if (projectSwitcher) projectSwitcher.open = false;
  stopBuildPolling();
  stopDeployPolling();
  invalidateWechatRequests();
  const selectionGeneration = wechatGeneration;
  currentId = id;
  currentProjectConfig = null;
  const targetsProjectId = options.publishTargetContext?.sourceProjectId || id;
  publishTargets = null;
  publishTargetsLoading = true;
  publishTargetsError = "";
  const targetGeneration = ++publishTargetsGeneration;
  renderPublishTargetPicker();
  versionSnapshot = null;
  cosSnapshot = null;
  cosFormProjectId = null;
  cfSnapshot = null;
  cfFormProjectId = null;
  cfTargetDrafts = [];
  cfMatrixDirty = false;
  packagesSnapshot = null;
  versionsLoading = false;
  versionsGeneration += 1;
  renderVersionManagement();
  renderPackagesPanel();
  resetResources();
  currentFile = "app.tsx";
  currentStatus = null;
  previewPath = `/api/projects/${encodeURIComponent(id)}/preview`;
  previewReady = false;
  previewHasFrame = false;
  previewStarted = false;
  previewRevision = null;
  previewGeneration = null;
  resetPreviewSurface();
  resetWechatPresentation();
  markDirty(false);
  renderProjects();
  setEnabled(false);
  resourcesLoading = true;
  renderResourceState();
  try {
    const [config, files, status, resources, targetResult] = await Promise.all([
      api(`/api/projects/${encodeURIComponent(id)}/config`),
      api(`/api/projects/${encodeURIComponent(id)}/files`),
      api(`/api/projects/${encodeURIComponent(id)}/status`),
      fetchResources(id),
      api(`/api/projects/${encodeURIComponent(targetsProjectId)}/publish-targets?channel=${encodeURIComponent(publishTargetChannel)}`)
        .then((payload) => ({ payload }))
        .catch((error) => ({ error })),
    ]);
    if (currentId !== id || selectionGeneration !== wechatGeneration) return;
    try { localStorage.setItem(projectSelectionStorageKey, id); } catch {}
    currentProjectConfig = config;
    syncProjectEcosystemUi(config);
    void loadProjectPackages();
    updateProjectHeading(projects.find((project) => project.id === id), config);
    $("config-name").value = config.name || "";
    $("config-app-id").value = config.appId || "";
    $("config-version").value = config.version || "";
    $("config-build").value = config.build ?? 0;
    updateConfigSaveFeedback();
    if (targetGeneration === publishTargetsGeneration) {
      setPublishTargets(targetResult.payload, targetResult.error);
      publishTargetsLoading = true;
      updateActionStates();
    }
    const fileList = files.files || files;
    renderFilePicker(fileList);
    const requestedInitialFile = pendingInitialFile && projectFiles.includes(pendingInitialFile) ? pendingInitialFile : "";
    if (requestedInitialFile) pendingInitialFile = "";
    await loadFile(requestedInitialFile || (projectFiles.includes(config.entry) ? config.entry : projectFiles.includes("app.tsx") ? "app.tsx" : projectFiles[0]));
    if (currentId !== id || selectionGeneration !== wechatGeneration) return;
    resourcesLoading = false;
    setResourceInventory(resources);
    setEnabled(true);
    renderStatus(status);
    if (targetGeneration === publishTargetsGeneration) {
      publishTargetsLoading = false;
      updateActionStates();
    }
    if (status?.busy) buildPollTimer = setTimeout(() => void pollBuild(), POLL_DELAY_MS);
    await loadWechat(id, selectionGeneration);
    if (currentId !== id || selectionGeneration !== wechatGeneration) return;
    await resumeDeployment(id);
  } catch (error) {
    if (targetGeneration === publishTargetsGeneration) {
      publishTargetsLoading = false;
      publishTargets = null;
      publishTargetsError = String(error?.message || error);
      renderPublishTargetPicker();
    }
    resourcesLoading = false;
    resetResources();
    setEnabled(false);
    showNotice(error);
  }
}

function setEnabled(enabled) {
  sourceEl.disabled = !enabled;
  $("file-picker").disabled = !enabled;
  for (const id of [...PROJECT_CONFIG_INPUTS, "config-build"]) $(id).disabled = !enabled;
  for (const id of ["open-packages-manager", "packages-search", "packages-refresh"]) {
    if ($(id)) $(id).disabled = !enabled || packagesBusy;
  }
  for (const id of ["open-ecosystem-builder", "ecosystem-preset-apple", "ecosystem-preset-android", "ecosystem-preset-clear", "apply-ecosystem-modules"]) {
    if ($(id)) $(id).disabled = !enabled || ecosystemApplying;
  }
  for (const box of document.querySelectorAll('#ecosystem-module-list input[type="checkbox"]')) {
    box.disabled = !enabled || ecosystemApplying;
  }
  if ($("source-toggle")) $("source-toggle").disabled = !enabled;
  if ($("source-split-toggle")) $("source-split-toggle").disabled = !enabled;
  updateActionStates();
}

async function loadProjects(preferred) {
  let configuredProjectId;
  try {
    const health = await api("/health");
    if (health?.csrfToken) csrfToken = health.csrfToken;
    if (health?.version && !studioUpgradeState) {
      renderStudioUpgrade({ currentVersion: health.version, status: "checking" });
    }
    if (health?.workspace) projectSelectionStorageKey = `pocket.studio.selected-project:${health.workspace}`;
    configuredProjectId = health?.projectId;
    localBluetoothAvailable = health?.bluetooth?.local === true;
    bluetoothProvider = "local";
    nobleBluetoothSupported = localBluetoothAvailable;
    updateBluetoothSettings();
  } catch {
    // The editor credential still lets local development continue.
  }
  let response = await api("/api/projects");
  projects = Array.isArray(response) ? response : response.projects || [];
  if (pendingInitialOpenPath) {
    const openTarget = pendingInitialOpenPath;
    pendingInitialOpenPath = "";
    const existing = projects.find((project) => project.directory === openTarget);
    if (existing) {
      if (!preferred && !pendingInitialProjectId) preferred = existing.id;
    } else {
      try {
        const opened = await api("/api/projects/open", {
          method: "POST",
          body: JSON.stringify({ path: openTarget }),
        });
        response = await api("/api/projects");
        projects = Array.isArray(response) ? response : response.projects || [];
        if (!preferred && !pendingInitialProjectId && opened?.id) preferred = opened.id;
      } catch (openError) {
        showNotice(openError);
      }
    }
  }
  if (pendingInitialProjectId) {
    if (!preferred) preferred = pendingInitialProjectId;
    pendingInitialProjectId = "";
  }
  renderProjects();
  let recent;
  try { recent = localStorage.getItem(projectSelectionStorageKey); } catch {}
  const id = [preferred, currentId, recent, configuredProjectId, projects[0]?.id].find(id => id && projects.some(project => project.id === id));
  if (id && projects.some((project) => project.id === id)) await selectProject(id);
  else clearSelectedProjectState();
}

function applyProjectConfig(config, { preserveDraft = false } = {}) {
  currentProjectConfig = config;
  if (!preserveDraft) {
    $("config-name").value = config.name || "";
    $("config-app-id").value = config.appId || "";
    $("config-version").value = config.version || "";
  }
  $("config-build").value = config.build ?? 0;
  syncProjectEcosystemUi(config);
  const headingConfig = preserveDraft ? {
    ...config,
    name: $("config-name").value,
    appId: $("config-app-id").value,
    version: $("config-version").value,
  } : config;
  updateProjectHeading(projects.find((project) => project.id === currentId), headingConfig);
  updateConfigSaveFeedback();
}

async function refreshProjectList() {
  try {
    const response = await api("/api/projects");
    projects = Array.isArray(response) ? response : response.projects || projects;
    renderProjects();
  } catch {
    // A refreshed project label is useful, but the saved config is already authoritative.
  }
}

async function saveProjectConfig({ alreadySaving = false } = {}) {
  if (!currentId || (saving && !alreadySaving)) return null;
  if (hasAppIdChange() && dirty && !alreadySaving) {
    setConfigSaveFeedback("请先保存源码，再保存应用 ID", "warn");
    showNotice("应用 ID 变更会更新源码中的包引用。当前源码有未保存修改，请先点击“保存源码”；它会先保存草稿，再应用身份变更。", "info");
    return null;
  }
  const projectId = currentId;
  const previousAppId = currentProjectConfig?.appId;
  clearNotice();
  if (!alreadySaving) saving = true;
  setConfigSaveFeedback("配置保存中…", "warn");
  updateActionStates();
  try {
    const config = await api(`/api/projects/${encodeURIComponent(projectId)}/config`, {
      method: "PUT",
      body: JSON.stringify({
        name: $("config-name").value,
        appId: $("config-app-id").value,
        version: $("config-version").value,
      }),
    });
    if (currentId !== projectId) return null;
    applyProjectConfig(config);
    renderStatus(config.status || currentStatus);
    if (previousAppId !== config.appId) {
      const source = await api(fileUrl(projectId, currentFile));
      if (currentId !== projectId) return null;
      sourceEl.value = source.content;
      setText("source-bytes", `${Number(source.bytes || 0).toLocaleString()} 字节`);
      markDirty(false);
    }
    await refreshProjectList();
    void refreshPublishTargets();
    setConfigSaveFeedback("配置已保存", "good");
    return config;
  } catch (error) {
    setConfigSaveFeedback("保存失败", "bad");
    showNotice(error);
    throw error;
  } finally {
    if (!alreadySaving) {
      saving = false;
      updateActionStates();
      resumeDeferredStudioUpgrade();
    }
  }
}

async function saveProject() {
  if (!currentId || saving) return;
  clearNotice();
  saving = true;
  setText("save-status", "保存中…");
  updateActionStates();
  try {
    const source = await api(fileUrl(currentId, currentFile), {
      method: "PUT",
      body: JSON.stringify({ content: sourceEl.value }),
    });
    await saveProjectConfig({ alreadySaving: true });
    setText("source-bytes", `${Number(source.bytes || 0).toLocaleString()} 字节`);
    markDirty(false);
  } catch (error) {
    setText("save-status", "保存失败");
    showNotice(error);
    throw error;
  } finally {
    saving = false;
    updateActionStates();
    resumeDeferredStudioUpgrade();
  }
}

async function buildProject() {
  if (!currentId || currentStatus?.busy || startingBuild) return;
  const projectId = currentId;
  clearNotice();
  try {
    if (dirty) await saveProject();
    else if (hasUnsavedProjectConfig()) await saveProjectConfig();
    if (currentId !== projectId) return;
    if (resourcesDirty) {
      showNotice("构建前请先保存资源策略。", "info");
      return;
    }
    startingBuild = true;
    updateActionStates();
    const result = await api(`/api/projects/${encodeURIComponent(projectId)}/build`, { method: "POST", body: "{}" });
    if (currentId !== projectId) return;
    renderStatus(result.status || result);
    stopBuildPolling();
    void pollBuild();
  } catch (error) {
    if (currentId === projectId) showNotice(error);
  } finally {
    startingBuild = false;
    updateActionStates();
  }
}

async function publishProject(channel = publishTargetChannel) {
  if (!currentId || publishing) return;
  const selectedTarget = activePublishTarget();
  if (selectedTarget?.kind === "reused") {
    if (selectedTarget.canSelect === false || !selectedTarget.ownerProjectId) {
      showNotice(selectedTarget.reason || `MiniApp ${selectedTarget.appId} 没有可用的所属项目。`, "error");
      return;
    }
    const ownerProjectId = selectedTarget.ownerProjectId;
    if (ownerProjectId !== currentId) {
      showNotice(`请从发布目标中选择 MiniApp ${selectedTarget.title || selectedTarget.appId}，先打开其所属项目。`, "info");
      return;
    }
  }
  const projectId = currentId;
  if (dirty) {
    showNotice("发布前请先保存源文件修改。", "info");
    return;
  }
  clearNotice();
  publishing = true;
  setPublishEditorLocked(true);
  $("publish-status").textContent = channel === "test" ? "正在发布签名测试包…" : "正在发布签名版本…";
  updateActionStates();
  try {
    const freshStatus = await api(`/api/projects/${encodeURIComponent(projectId)}/status`);
    if (currentId !== projectId) return;
    renderStatus(freshStatus);
    if (dirty) {
      showNotice("发布前请先保存源文件修改。", "info");
      return;
    }
    if (!freshStatus || freshStatus.busy || freshStatus.builtRevision !== freshStatus.revision || freshStatus.error) {
      showNotice("发布前请先构建已保存的项目。", "info");
      return;
    }
    const result = await api(`/api/projects/${encodeURIComponent(projectId)}/publish`, {
      method: "POST",
      body: JSON.stringify({ channel }),
    });
    if (currentId !== projectId) return;
    renderStatus(result.status || result);
    versionSnapshot = null;
    if (versionsLoading) {
      versionsGeneration += 1;
      versionsLoading = false;
    }
    void loadVersions();
    if (!resourcesDirty) {
      void loadResources(projectId).catch(showNotice);
    }
    void refreshPublishTargets();
    if (result.cloudflarePublish) {
      void loadCloudflareConfig();
    }
    const syncErrors = [
      result.cosError ? `COS：${result.cosError}` : "",
      result.cloudflareError ? `Cloudflare：${result.cloudflareError}` : "",
    ].filter(Boolean);
    const syncedTargets = [
      result.cosPublish ? "腾讯云 COS" : "",
      result.cloudflarePublish ? "Cloudflare R2" : "",
    ].filter(Boolean);
    const channelLabel = channel === "test" ? "测试" : "稳定版";
    if (syncErrors.length > 0) {
      showNotice(`${channelLabel}本地资源包已发布，但远端同步失败（${syncErrors.join("；")}）`, "error");
    } else if (syncedTargets.length > 0) {
      showNotice(`${channelLabel}资源包已发布并同步到 ${syncedTargets.join(" 与 ")}。`, "success");
    } else {
      showNotice(`${channelLabel}资源包已发布。`, "success");
    }
  } catch (error) {
    if (currentId === projectId) {
      setText("publish-status", `${channel === "test" ? "测试" : "稳定版"}发布失败`);
      showNotice(error);
    }
  } finally {
    publishing = false;
    setPublishEditorLocked(false);
    updateActionStates();
  }
}

function setPreviewState(label, kind = "") {
  const state = $("preview-state");
  state.innerHTML = `<i></i>${label}`;
  state.className = `live-chip${kind ? ` ${kind}` : ""}`;
}

function resetPreviewSurface() {
  previewLoadSequence++;
  previewGpuAvailable = false;
  previewGpuRequested = currentId ? savedGpuPreviewPreference() : false;
  setPreviewRenderer(false);
  previewFrame.hidden = true;
  previewFrame.src = "about:blank";
  previewRegionsEnabled = false;
  $("preview-empty").hidden = false;
  setPreviewState("等待中");
  updateActionStates();
}

function maybeRefreshPreview(status) {
  if (!status || status.busy || status.error || status.builtRevision !== status.revision || dirty) return;
  if (previewStarted && previewRevision === status.builtRevision && previewGeneration === (status.artifacts?.generation ?? status.finishedAt ?? null)) return;
  void refreshPreview({ automatic: true });
}

function gpuPreviewSupportsViewport(viewportKey = $("viewport-picker").value) {
  if (activeSurfaceProfile(viewportKey)) return false;
  return viewportKey === "mobile" || Object.values(safeAreaForViewport(viewportKey)).every(inset => inset === 0);
}

function savedGpuPreviewPreference() {
  try { return localStorage.getItem(PREVIEW_GPU_STORAGE_PREFIX + currentId) === "1"; } catch { return false; }
}

function setPreviewRenderer(gpu) {
  previewGpuActive = gpu;
  setText("preview-renderer-label", gpu ? "Web" : "Flutter");
  setText("preview-surface-renderer", gpu ? "Web" : "Flutter");
  setText("preview-surface-engine", gpu ? "直连预览 · 位图文字" : "原生画布");
  setText("copy-preview-link", gpu ? "复制 Web 链接" : "复制 Flutter 链接");
}

async function refreshPreview({ automatic = false, forceNative = false } = {}) {
  if (!currentId) return;
  if (dirty) {
    if (!automatic) showNotice("刷新预览前请先保存源文件修改。", "info");
    return;
  }
  if (!currentStatus || currentStatus.builtRevision !== currentStatus.revision || currentStatus.error) {
    if (!automatic) showNotice("刷新预览前请先构建已保存的项目。", "info");
    return;
  }
  clearNotice();
  const request = ++previewLoadSequence;
  const projectId = currentId;
  const path = previewPath;
  const status = currentStatus;
  previewReady = false;
  previewHasFrame = false;
  setPreviewState("加载中", "loading");
  $("preview-empty").hidden = true;
  previewStarted = true;
  previewRevision = status.builtRevision;
  previewGeneration = status.artifacts?.generation ?? status.finishedAt ?? null;
  updateActionStates();
  const availability = await api(path + "/gpu/status", { cache: "no-store" }).catch(() => null);
  if (request !== previewLoadSequence || currentId !== projectId) return;
  if (dirty || currentStatus?.builtRevision !== previewRevision ||
      (currentStatus?.artifacts?.generation ?? currentStatus?.finishedAt ?? null) !== previewGeneration) {
    previewStarted = false;
    return;
  }
  previewGpuAvailable = availability?.available === true;
  setPreviewRenderer(!forceNative && previewGpuAvailable && previewGpuRequested &&
    !pendingInitialOpenUri && gpuPreviewSupportsViewport());
  previewFrame.hidden = false;
  layoutPreviewFrame();
  const url = previewBrowserUrl();
  url.searchParams.set("t", String(Date.now()));
  // The old iframe can present while the GPU availability request is pending.
  previewReady = false;
  previewHasFrame = false;
  setPreviewState("加载中", "loading");
  previewFrame.src = url.href;
  updateActionStates();
}

function previewBrowserUrl() {
  const url = new URL(previewPath, window.location.origin);
  if (previewGpuActive) {
    url.pathname += "/gpu/";
    return url;
  }
  if (previewRegionsEnabled) url.searchParams.set("regions", "1");
  if (webBluetoothEnabled) { url.searchParams.set("webBluetooth", "1"); url.searchParams.set("bluetoothProvider", "local"); }
  return url;
}

function sendPreviewPlugins() {
  if (previewGpuActive) return;
  previewFrame.contentWindow?.postMessage({ source: "pocket-editor", type: "preview.plugins", webBluetooth: webBluetoothEnabled, bluetoothProvider }, window.location.origin);
}

function captureFromMessage(message) {
  const requestId = message.requestId || message.id;
  const dataUrl = message.dataUrl || message.imageDataUrl || message.screenshot || (typeof message.data === "string" && message.data.startsWith("data:image/") ? message.data : "");
  if (!requestId || (!dataUrl && typeof message.error !== "string")) return false;
  const waiter = captureWaiters.get(requestId);
  if (!waiter) return false;
  captureWaiters.delete(requestId);
  if (!dataUrl) {
    waiter.reject(new Error(message.error));
    return true;
  }
  waiter.resolve({
    dataUrl,
    width: Number.isFinite(Number(message.width)) ? Number(message.width) : undefined,
    height: Number.isFinite(Number(message.height)) ? Number(message.height) : undefined,
    logicalWidth: Number.isFinite(Number(message.logicalWidth)) ? Number(message.logicalWidth) : undefined,
    logicalHeight: Number.isFinite(Number(message.logicalHeight)) ? Number(message.logicalHeight) : undefined,
  });
  return true;
}

async function capturePreview() {
  if (!previewReady || previewFrame.hidden) throw new Error("请先刷新预览，再截取截图。");
  const requestId = `capture-${Date.now()}-${++captureSequence}`;
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      captureWaiters.delete(requestId);
      reject(new Error("预览没有返回截图，请刷新后重试。"));
    }, 1800);
    captureWaiters.set(requestId, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
  });
  previewFrame.contentWindow?.postMessage({ source: "pocket-editor", type: "preview.capture", requestId, scale: 1 }, window.location.origin);
  const result = await promise;
  const capture = typeof result === "string" ? { dataUrl: result } : result;
  const dataUrl = capture.dataUrl;
  if (!/^data:image\/(?:png|jpeg|webp);base64,/i.test(dataUrl)) throw new Error("预览截图必须是 PNG、JPEG 或 WebP 图片。");
  return { ...capture, dataUrl, type: dataUrl.slice(5, dataUrl.indexOf(";")) };
}

function downloadPreviewCapture(capture) {
  const link = document.createElement("a");
  link.href = capture.dataUrl;
  link.download = `${currentId || "pocket-preview"}.png`;
  link.click();
}

async function copyPreviewLink() {
  if (!previewPath) {
    showNotice("复制预览地址前请先选择项目。", "info");
    return;
  }
  if (!currentStatus || currentStatus.builtRevision !== currentStatus.revision || currentStatus.error || dirty) {
    showNotice("复制预览地址前请先构建已保存的项目。", "info");
    return;
  }
  const urlObject = previewBrowserUrl();
  const url = urlObject.href;
  try {
    if (!navigator.clipboard?.writeText) throw new Error("此浏览器不支持剪贴板访问。");
    await navigator.clipboard.writeText(url);
    showNotice("预览地址已复制，可直接在 Codex 浏览器中打开。", "success");
  } catch (error) {
    showNotice(error);
  }
}

function viewportEntryFor(viewportKey = $("viewport-picker")?.value || "mobile") {
  const profile = activeSurfaceProfile(viewportKey);
  if (profile) {
    return {
      width: profile.width,
      height: profile.height,
      label: profile.label,
      safeArea: profile.safeArea ? { ...profile.safeArea } : { top: 0, right: 0, bottom: 0, left: 0 },
      reservedRegions: Array.isArray(profile.reservedRegions) ? profile.reservedRegions : [],
      profile,
    };
  }
  return VIEWPORTS[viewportKey] || VIEWPORTS.mobile;
}

function clearDynamicViewportClasses(element) {
  if (!element) return;
  for (const cls of Array.from(element.classList)) {
    if (
      cls.startsWith("viewport-") ||
      cls.startsWith("surface-shell-") ||
      cls.startsWith("surface-shape-") ||
      cls.startsWith("surface-backdrop-") ||
      cls === "surface-system-widget"
    ) {
      element.classList.remove(cls);
    }
  }
}

function setViewport(value, options = {}) {
  const profile = activeSurfaceProfile(value);
  if (!options.preserveRenderMode) {
    currentSurfaceRenderMode = profile?.defaultRenderMode || "";
  }
  if (!options.keepWidgetSnapshot) {
    latestWidgetSnapshot = null;
  }
  clearDynamicViewportClasses(previewStage);
  previewStage.classList.add(`viewport-${value}`);
  if (profile) previewStage.classList.add("viewport-surface-profile");
  syncSurfaceToolbarControls(value);
  updatePreviewPhoneShell(value);
  layoutPreviewFrame();
  if (previewGpuActive && (options.openUri || !gpuPreviewSupportsViewport(value))) {
    if (options.openUri) pendingInitialOpenUri = options.openUri;
    void refreshPreview({ automatic: true, forceNative: true });
    return;
  }
  if (!previewGpuActive && previewGpuAvailable && previewGpuRequested && !options.openUri &&
      gpuPreviewSupportsViewport(value)) {
    void refreshPreview({ automatic: true });
    return;
  }
  updateActionStates();
  resizePreviewRuntime(options);
  sendPreviewRegions();
}

function safeAreaForViewport(viewportKey) {
  const entry = viewportEntryFor(viewportKey);
  const safeArea = entry?.safeArea;
  return safeArea ? { ...safeArea } : { top: 0, right: 0, bottom: 0, left: 0 };
}

function updatePreviewPhoneShell(viewportKey = $("viewport-picker")?.value || "mobile") {
  const profile = activeSurfaceProfile(viewportKey);
  const isLegacyMobile = viewportKey === "mobile" && Boolean(previewDeviceProfile);
  const shellSpec = profile?.shell || (isLegacyMobile ? previewDeviceProfile?.shell : null);
  const variant = profile ? (shellSpec?.variant || "none") : (isLegacyMobile ? "phone-island" : "none");
  const visible = isLegacyMobile || Boolean(profile && variant !== "none");

  if (previewStage) {
    for (const cls of Array.from(previewStage.classList)) {
      if (cls.startsWith("surface-shell-") || cls.startsWith("surface-shape-") || cls.startsWith("surface-backdrop-") || cls === "surface-system-widget") {
        previewStage.classList.remove(cls);
      }
    }
    if (profile) {
      previewStage.classList.add(`surface-shell-${variant}`);
      previewStage.classList.add(`surface-shape-${profile.screenShape || "rect"}`);
      previewStage.classList.add(`surface-backdrop-${shellSpec?.wallpaper || "none"}`);
      if (isSystemWidgetProfile(profile)) previewStage.classList.add("surface-system-widget");
    }
    previewStage.classList.toggle("preview-phone-frame", visible);
  }

  if (previewPhoneShell) {
    previewPhoneShell.toggleAttribute("hidden", !visible);
    previewPhoneShell.setAttribute("aria-hidden", "true");
    const statusBar = previewPhoneShell.querySelector(".preview-phone-statusbar");
    const notch = previewPhoneShell.querySelector(".preview-phone-notch");
    const homeIndicator = previewPhoneShell.querySelector(".preview-phone-home-indicator");
    const macTitlebar = previewPhoneShell.querySelector(".preview-macos-titlebar");
    const foldHinge = previewPhoneShell.querySelector(".preview-fold-hinge");
    const watchCrown = previewPhoneShell.querySelector(".preview-watch-crown");
    const macTitleText = $("preview-macos-title");

    if (isLegacyMobile && !profile) {
      statusBar?.toggleAttribute("hidden", false);
      notch?.toggleAttribute("hidden", false);
      homeIndicator?.toggleAttribute("hidden", false);
      macTitlebar?.toggleAttribute("hidden", true);
      foldHinge?.toggleAttribute("hidden", true);
      watchCrown?.toggleAttribute("hidden", true);
    } else if (profile && shellSpec) {
      const cutoutW = shellSpec.cutoutWidth ?? shellSpec.notchWidth ?? 0;
      const cutoutH = shellSpec.cutoutHeight ?? shellSpec.notchHeight ?? 0;
      const showStatusBar = (shellSpec.statusBarHeight || 0) > 0 &&
        (variant === "phone-island" || variant === "phone-notch" || variant === "phone-punch" || variant === "tablet" || variant === "foldable-open");
      const showNotch = cutoutW > 0 && cutoutH > 0 && variant !== "dynamic-island";
      const showHome = (shellSpec.homeIndicatorWidth || 0) > 0 && (shellSpec.homeIndicatorHeight || 0) > 0;
      statusBar?.toggleAttribute("hidden", !showStatusBar);
      notch?.toggleAttribute("hidden", !showNotch);
      homeIndicator?.toggleAttribute("hidden", !showHome);
      macTitlebar?.toggleAttribute("hidden", variant !== "macos-window");
      if (macTitleText && variant === "macos-window") {
        macTitleText.textContent = `${currentId || "Pocket App"} — ${profile.shortLabel || profile.label}`;
      }
      foldHinge?.toggleAttribute("hidden", variant !== "foldable-open");
      watchCrown?.toggleAttribute("hidden", variant !== "watch-rect" && variant !== "watch-round");
    }
  }
}

function updatePreviewBezelPresentation(viewportKey = $("viewport-picker")?.value || "mobile") {
  const profile = activeSurfaceProfile(viewportKey);
  const supportsBezel =
    (Boolean(previewDeviceProfile) && viewportKey === "mobile") ||
    Boolean(profile && ((profile.shell?.bezel || 0) > 0 || isSystemWidgetProfile(profile)));
  const canvasBezel = supportsBezel && (previewBezelEnabled || Boolean(profile && isSystemWidgetProfile(profile)));
  previewStage?.classList.toggle("preview-bezel-enabled", canvasBezel);
  wechatPreviewShell?.classList.toggle("preview-bezel-enabled", previewBezelEnabled);
}

function layoutPreviewFrame() {
  const viewportKey = $("viewport-picker").value;
  const viewport = viewportEntryFor(viewportKey);
  if (!viewport || !Number.isFinite(viewport.width) || viewport.width <= 0 || !Number.isFinite(viewport.height) || viewport.height <= 0) return;
  updatePreviewPhoneShell(viewportKey);
  updatePreviewBezelPresentation(viewportKey);
  setText("preview-device-label", `${viewport.label} · ${viewport.width} × ${viewport.height}`);
  const wrapStyle = previewStageWrap ? getComputedStyle(previewStageWrap) : null;
  const horizontalPadding = wrapStyle ? Number.parseFloat(wrapStyle.paddingLeft || "0") + Number.parseFloat(wrapStyle.paddingRight || "0") : 0;
  const verticalPadding = wrapStyle ? Number.parseFloat(wrapStyle.paddingTop || "0") + Number.parseFloat(wrapStyle.paddingBottom || "0") : 0;
  const availableWidth = Math.max(1, (previewStageWrap?.clientWidth || previewStage.getBoundingClientRect().width) - horizontalPadding);
  const gridStyle = previewSurfaces ? getComputedStyle(previewSurfaces) : null;
  const gridColumns = gridStyle?.gridTemplateColumns.split(/\s+/).map((value) => Number.parseFloat(value)).filter((value) => Number.isFinite(value) && value > 0) || [];
  const stageWidth = gridColumns[0] || availableWidth;
  const targetWrapHeight = Number.isFinite(previewPaneHeight) && previewPaneHeight > 0
    ? previewPaneHeight
    : (previewStageWrap?.clientHeight || previewStage.getBoundingClientRect().height);
  const availableHeight = Math.max(1, targetWrapHeight - verticalPadding);
  // The selected viewport remains the logical width/height sent to the
  // guest. Only the presentation scale changes with the available pane size;
  // cap it at 1 so a tall pane never invents a larger logical viewport.
  const scale = Math.min(stageWidth / viewport.width, availableHeight / viewport.height, 1);
  if (!Number.isFinite(scale) || scale <= 0) return;
  const targetStageWidth = Math.round(viewport.width * scale);
  const targetStageHeight = Math.round(viewport.height * scale);
  previewStage.style.transition = "none";
  previewStage.style.width = `${targetStageWidth}px`;
  previewStage.style.height = `${targetStageHeight}px`;
  previewStage.style.aspectRatio = "auto";
  previewFrame.style.width = `${viewport.width}px`;
  previewFrame.style.height = `${viewport.height}px`;
  previewFrame.style.transform = `scale(${scale})`;
  const activeProfile = viewport.profile || null;
  const shellSource = activeProfile
    ? { screenWidth: activeProfile.width, screenHeight: activeProfile.height, statusBarHeight: activeProfile.shell?.statusBarHeight || 0, shell: activeProfile.shell }
    : (viewportKey === "mobile" && previewDeviceProfile ? previewDeviceProfile : null);
  if (shellSource && shellSource.shell && previewPhoneShell && !previewPhoneShell.hidden) {
    const { screenWidth, screenHeight, statusBarHeight, shell } = shellSource;
    // The shell is kept in the runner's logical coordinate space and scaled
    // exactly like the guest iframe. This keeps notch/status/home geometry and
    // pointer coordinates aligned when the pane is narrow or short.
    previewPhoneShell.style.width = `${screenWidth}px`;
    previewPhoneShell.style.height = `${screenHeight}px`;
    previewPhoneShell.style.borderRadius = `${shell.borderRadius || 0}px`;
    previewPhoneShell.style.transformOrigin = "top left";
    previewPhoneShell.style.transform = `scale(${scale})`;
    previewStage.style.setProperty("--preview-phone-radius", `${(shell.borderRadius || 0) * scale}px`);
    previewStage.style.setProperty("--preview-phone-bezel", `${(shell.bezel || 0) * scale}px`);
    previewStage.style.setProperty("--preview-phone-notch-width", `${shell.cutoutWidth ?? shell.notchWidth ?? 0}px`);
    previewStage.style.setProperty("--preview-phone-notch-height", `${shell.cutoutHeight ?? shell.notchHeight ?? 0}px`);
    previewStage.style.setProperty("--preview-phone-statusbar-height", `${statusBarHeight || 0}px`);
    previewStage.style.setProperty("--preview-phone-home-width", `${shell.homeIndicatorWidth || 0}px`);
    previewStage.style.setProperty("--preview-phone-home-height", `${shell.homeIndicatorHeight || 0}px`);
    previewStage.style.setProperty("--preview-phone-home-bottom", `${shell.homeIndicatorBottom || 0}px`);
  } else if (previewPhoneShell) {
    previewPhoneShell.style.removeProperty("width");
    previewPhoneShell.style.removeProperty("height");
    previewPhoneShell.style.removeProperty("border-radius");
    previewPhoneShell.style.removeProperty("transform");
    previewPhoneShell.style.removeProperty("transform-origin");
    previewStage.style.removeProperty("--preview-phone-radius");
    previewStage.style.removeProperty("--preview-phone-bezel");
  }
  layoutWechatPreview();
}

function layoutWechatPreview() {
  if (!wechatPreviewPane || wechatPreviewPane.hidden || !previewStageWrap || !previewSurfaces) return;
  const slot = previewStage.getBoundingClientRect();
  const width = Math.max(1, Math.round(slot.width));
  const height = Math.max(1, Math.round(slot.height));
  wechatPreviewPane.style.width = `${width}px`;
  wechatPreviewPane.style.height = `${height}px`;
  const viewport = wechatPreviewPane.querySelector(".wechat-preview-viewport");
  if (viewport) {
    viewport.style.width = `${width}px`;
    viewport.style.height = `${height}px`;
    viewport.style.aspectRatio = "auto";
  }
  layoutWechatFrame();
}

function layoutWechatFrame() {
  if (!wechatPreviewFrame || !wechatPreviewPane || wechatPreviewPane.hidden) return;
  const viewport = wechatPreviewPane.querySelector(".wechat-preview-viewport");
  const width = viewport?.clientWidth || wechatPreviewPane.clientWidth;
  const height = viewport?.clientHeight || wechatPreviewPane.clientHeight;
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return;
  const device = previewDeviceProfile;
  if (!device) return;
  const screenWidth = device.screenWidth;
  const screenHeight = device.screenHeight;
  const scale = Math.min(width / screenWidth, height / screenHeight);
  const renderedWidth = screenWidth * scale;
  const renderedHeight = screenHeight * scale;
  wechatPreviewFrame.style.width = `${screenWidth}px`;
  wechatPreviewFrame.style.height = `${screenHeight}px`;
  wechatPreviewFrame.style.left = `${Math.max(0, (width - renderedWidth) / 2)}px`;
  wechatPreviewFrame.style.top = `${Math.max(0, (height - renderedHeight) / 2)}px`;
  wechatPreviewFrame.style.transformOrigin = "top left";
  wechatPreviewFrame.style.transform = `scale(${scale})`;
  if (wechatPreviewShell) {
    wechatPreviewShell.style.setProperty("--wechat-device-radius", `${device.shell.borderRadius * scale}px`);
    wechatPreviewShell.style.setProperty("--wechat-device-bezel", `${device.shell.bezel * scale}px`);
  }
}

function resizePreviewRuntime(options = {}) {
  const viewportKey = $("viewport-picker").value;
  const viewport = viewportEntryFor(viewportKey);
  if (!viewport || !Number.isFinite(viewport.width) || viewport.width <= 0 || !Number.isFinite(viewport.height) || viewport.height <= 0) return;
  if (previewGpuActive) {
    previewFrame.contentWindow?.postMessage({
      source: "pocket-editor", type: "preview.resize",
      width: viewport.width, height: viewport.height,
    }, window.location.origin);
    return;
  }
  if (viewport.profile) {
    previewFrame.contentWindow?.postMessage({
      source: "pocket-editor",
      type: "preview.surface",
      profileId: viewport.profile.id,
      width: viewport.width,
      height: viewport.height,
      safeArea: safeAreaForViewport(viewportKey),
      reservedRegions: viewport.reservedRegions || [],
      renderMode: currentSurfaceRenderMode || viewport.profile.defaultRenderMode || "fullColor",
      ...(options.openUri ? { openUri: options.openUri } : {}),
    }, window.location.origin);
    return;
  }
  previewFrame.contentWindow?.postMessage({
    source: "pocket-editor",
    type: "preview.resize",
    width: viewport.width,
    height: viewport.height,
    safeArea: safeAreaForViewport(viewportKey),
    reservedRegions: [],
    surface: null,
    ...(options.openUri ? { openUri: options.openUri } : {}),
  }, window.location.origin);
}

function sendPreviewRegions() {
  if (previewGpuActive) return;
  previewFrame.contentWindow?.postMessage({ source: "pocket-editor", type: "preview.regions", enabled: previewRegionsEnabled }, window.location.origin);
}

function setupPreviewHeightControl() {
  const handle = $("resize-preview-height");
  if (!handle || !previewStageWrap) return;
  const min = 240;
  const max = 1200;
  const read = () => previewPaneHeight ?? Math.round(previewStageWrap.getBoundingClientRect().height || 390);
  const apply = (value, persist = true) => {
    const next = Math.round(Math.max(min, Math.min(max, Number(value) || min)));
    previewPaneHeight = next;
    previewStageWrap.style.setProperty("--preview-height", `${next}px`);
    handle.setAttribute("aria-valuenow", String(next));
    if (persist) {
      try { localStorage.setItem(PREVIEW_HEIGHT_STORAGE_KEY, String(next)); } catch {}
    }
    layoutPreviewFrame();
  };
  let drag;
  const finish = (event) => {
    if (!drag) return;
    apply(drag.initial + event.clientY - drag.start);
    drag = undefined;
    handle.classList.remove("dragging");
    handle.releasePointerCapture?.(event.pointerId);
  };
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    drag = { initial: read(), start: event.clientY };
    handle.classList.add("dragging");
    handle.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });
  handle.addEventListener("pointermove", (event) => {
    if (drag) apply(drag.initial + event.clientY - drag.start, false);
  });
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
  handle.addEventListener("keydown", (event) => {
    const current = read();
    let next = current;
    if (event.key === "ArrowUp") next = current - 20;
    else if (event.key === "ArrowDown") next = current + 20;
    else if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    else return;
    event.preventDefault();
    apply(next);
  });
  if (previewPaneHeight !== null) apply(previewPaneHeight, false);
  else handle.setAttribute("aria-valuenow", String(read()));
}

function renderDevices() {
  const picker = $("device-picker");
  picker.replaceChildren();
  if (!devices.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "没有可用设备";
    picker.append(option);
    setText("device-help", "没有可用的模拟器或已连接设备。");
  } else {
    for (const device of devices) {
      const option = document.createElement("option");
      option.value = device.id;
      option.disabled = device.supported === false || device.available === false;
      const kind = device.emulator ? "模拟器" : "已连接设备";
      option.textContent = `${device.name || device.id} · ${device.platform || "未知平台"} · ${kind}${option.disabled ? " · 不支持" : ""}`;
      picker.append(option);
    }
    setText("device-help", "部署会把最新构建包发送到选中的本地目标。");
  }
  updateActionStates();
}

async function loadDevices() {
  try {
    const response = await api("/api/devices");
    devices = Array.isArray(response) ? response : response.devices || [];
  } catch (error) {
    devices = [];
    setText("device-help", `设备发现不可用：${normalizeError(error).message}`);
  }
  renderDevices();
}

function stopDeployPolling() {
  if (deployPollTimer) clearTimeout(deployPollTimer);
  deployPollTimer = null;
  activeDeploy = null;
  updateActionStates();
}

function renderDeploy(job) {
  const status = String(job?.status || "").toLowerCase();
  const terminal = ["completed", "success", "succeeded", "failed", "error", "cancelled", "canceled"].includes(status);
  const state = $("deploy-state");
  const statusLabels = { queued: "排队中", building: "构建中", starting: "启动中", running: "运行中", completed: "已完成", success: "成功", succeeded: "成功", failed: "失败", error: "错误", cancelled: "已取消", canceled: "已取消", stopping: "停止中" };
  state.textContent = statusLabels[status] || (status ? status : "排队中");
  state.className = `meta-chip${terminal && ["failed", "error"].includes(status) ? " bad" : terminal ? " good" : ""}`;
  const logs = Array.isArray(job?.logs) ? job.logs : job?.logs ? [job.logs] : [];
  $("deploy-log").textContent = logs.join("\n") || job?.error || (status ? `任务状态：${status}` : "等待部署状态…");
  $("deploy-log").scrollTop = $("deploy-log").scrollHeight;
}

async function resumeDeployment(projectId) {
  const result = await api(`/api/projects/${encodeURIComponent(projectId)}/deploy`);
  if (currentId !== projectId) return;
  const jobs = result.jobs || [];
  const job = jobs.find((item) => ["queued", "building", "starting", "running", "stopping"].includes(item.status));
  if (!job) return;
  activeDeploy = { id: job.id, status: job.status };
  renderDeploy(job);
  updateActionStates();
  if (job.status !== "running") void pollDeploy();
}

async function pollDeploy(attempt = 0) {
  if (!currentId || !activeDeploy || attempt > MAX_DEPLOY_POLL_ATTEMPTS) {
    stopDeployPolling();
    return;
  }
  try {
    const job = await api(`/api/projects/${encodeURIComponent(currentId)}/deploy/${encodeURIComponent(activeDeploy.id)}`);
    renderDeploy(job);
    const status = String(job?.status || "").toLowerCase();
    activeDeploy.status = status;
    if (["completed", "success", "succeeded", "failed", "error", "cancelled", "canceled"].includes(status)) {
      activeDeploy = null;
      deployPollTimer = null;
      updateActionStates();
      return;
    }
    // A running Flutter process is a successful deploy. Keep the Stop button
    // available, but stop polling its logs to avoid a background hot loop.
    if (status === "running") {
      deployPollTimer = null;
      updateActionStates();
      return;
    }
    deployPollTimer = setTimeout(() => void pollDeploy(attempt + 1), POLL_DELAY_MS);
  } catch (error) {
    stopDeployPolling();
    showNotice(error);
  }
}

async function deployProject() {
  if (!currentId || !$("device-picker").value || activeDeploy || startingDeploy) return;
  if (dirty) {
    try { await saveProject(); } catch { return; }
  }
  if (currentStatus?.builtRevision !== currentStatus?.revision || currentStatus?.error) {
    showNotice("部署前请先构建已保存的项目。", "info");
    return;
  }
  clearNotice();
  startingDeploy = true;
  updateActionStates();
  try {
    setText("deploy-state", "启动中…");
    const result = await api(`/api/projects/${encodeURIComponent(currentId)}/deploy`, {
      method: "POST",
      body: JSON.stringify({ deviceId: $("device-picker").value }),
    });
    const job = result.job || result;
    const jobId = job.id || result.id;
    if (!jobId) throw new Error("部署没有返回任务 ID。");
    activeDeploy = { id: jobId };
    renderDeploy(job);
    void pollDeploy();
    updateActionStates();
  } catch (error) {
    setText("deploy-state", "失败");
    showNotice(error);
  } finally {
    startingDeploy = false;
    updateActionStates();
  }
}

async function cancelDeploy() {
  if (!currentId || !activeDeploy) return;
  const id = activeDeploy.id;
  try {
    await api(`/api/projects/${encodeURIComponent(currentId)}/deploy/${encodeURIComponent(id)}`, { method: "DELETE" });
    renderDeploy({ status: "cancelled", logs: ["部署已取消。"] });
  } catch (error) {
    showNotice(error);
  } finally {
    stopDeployPolling();
  }
}

function refreshSourceFromServer() {
  if (!currentId) return;
  if (dirty && !window.confirm("放弃当前未保存草稿并重新加载源文件？")) return;
  clearNotice();
  void refreshFiles({ preserveDraft: false }).catch(showNotice);
}

window.addEventListener("message", (event) => {
  if (event.origin !== window.location.origin || event.source !== previewFrame.contentWindow) return;
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (previewGpuActive !== (data.renderer === "gpu")) return;
  if (previewGpuActive && (data.source !== "pocket-editor-preview" || data.version !== 1)) return;
  if (data.type === "preview.ready") {
    previewReady = false;
    previewHasFrame = false;
    const initialOpenUri = pendingInitialOpenUri;
    if (initialOpenUri) pendingInitialOpenUri = "";
    resizePreviewRuntime(initialOpenUri ? { openUri: initialOpenUri } : {});
    sendPreviewRegions();
    sendPreviewPlugins();
    setPreviewState("启动中", "loading");
    updateActionStates();
  }
  if (data.type === "preview.frame") {
    previewHasFrame = true;
    previewReady = true;
    sendPreviewRegions();
    setPreviewState("就绪", "ready");
    updateActionStates();
  }
  if (!previewGpuActive && data.type === "preview.widget-snapshot" && data.snapshot && typeof data.snapshot === "object") {
    latestWidgetSnapshot = data.snapshot;
    syncSurfaceToolbarControls();
  }
  if (data.type === "preview.status") {
    const status = typeof data.status === "string" ? data.status : data.status?.state;
    if (data.status?.hostConfig === "invalid" && previewHostNoticeProject !== currentId) {
      previewHostNoticeProject = currentId;
      showNotice("本机预览配置不可用，预览将使用默认环境。", "info");
    } else if (data.status?.hostConfig === "ready" || data.status?.hostConfig === "disabled") {
      previewHostNoticeProject = "";
    }
    if (status === "error" || status === "stopped") {
      previewReady = false;
      setPreviewState(status === "error" ? "预览错误" : "已停止", "loading");
      if (status === "error") showNotice(data.error || data.status?.error || (previewGpuActive ? "GPU 预览报告了错误。" : "原生预览报告了错误。"));
    } else if (status === "starting") {
      previewReady = false;
      setPreviewState("启动中", "loading");
    } else if (status === "reconnecting") {
      previewReady = false;
      setPreviewState("重连中…", "loading");
    } else if (status === "ready" && previewHasFrame) {
      previewReady = true;
      setPreviewState("就绪", "ready");
    }
    updateActionStates();
  }
  if (data.type === "preview.error") {
    previewReady = false;
    setPreviewState("预览错误", "loading");
    showNotice(data.error || (previewGpuActive ? "GPU 预览报告了错误。" : "原生预览报告了错误。"));
    updateActionStates();
  }
  if (data.type === "preview.capture.result") captureFromMessage(data);
});

previewFrame.addEventListener("load", () => {
  if (previewFrame.src === "about:blank") return;
  layoutPreviewFrame();
  if (previewGpuActive) return;
  previewReady = false;
  previewHasFrame = false;
  sendPreviewRegions();
  setPreviewState("启动中", "loading");
  updateActionStates();
});
previewFrame.addEventListener("error", () => {
  previewReady = false;
  setPreviewState("预览错误", "loading");
  showNotice("项目预览无法加载。");
  updateActionStates();
});
window.addEventListener("resize", layoutPreviewFrame);
if (typeof ResizeObserver === "function") {
  const previewObserver = new ResizeObserver(layoutPreviewFrame);
  previewObserver.observe(previewStage);
  if (previewStageWrap) previewObserver.observe(previewStageWrap);
  if (previewSurfaces) previewObserver.observe(previewSurfaces);
}

const openProjectDialog = $("open-project-dialog");
let directorySelectionId = 0;
openProjectDialog.addEventListener("close", () => { directorySelectionId += 1; });
async function browseProjectDirectory() {
  const selectionId = ++directorySelectionId;
  const button = $("browse-project-directory");
  const errorText = $("open-project-error");
  button.disabled = true;
  button.textContent = "正在选择…";
  errorText.hidden = true;
  try {
    const result = await api("/api/projects/pick-directory", { method: "POST", body: "{}" });
    if (result.path && openProjectDialog.open && selectionId === directorySelectionId) {
      $("open-project-form").elements.namedItem("path").value = result.path;
      $("open-project-form").requestSubmit();
    }
  } catch (error) {
    errorText.textContent = error.message || String(error);
    errorText.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "选择本地目录…";
  }
}
$("browse-project-directory").addEventListener("click", browseProjectDirectory);
$("open-project").addEventListener("click", () => {
  $("open-project-form").reset();
  $("open-project-error").hidden = true;
  openProjectDialog.showModal();
  void browseProjectDirectory();
});
$("cancel-open-project").addEventListener("click", () => openProjectDialog.close());
$("open-project-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("confirm-open-project");
  const errorText = $("open-project-error");
  button.disabled = true;
  button.textContent = "正在打开…";
  errorText.hidden = true;
  try {
    const result = await api("/api/projects/open", { method: "POST", body: JSON.stringify({ path: new FormData(event.currentTarget).get("path") }) });
    await loadProjects(result.id);
    openProjectDialog.close();
    clearNotice();
  } catch (error) {
    errorText.textContent = error.message || String(error);
    errorText.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "打开项目";
  }
});

const examplesDialog = $("examples-dialog");
const examplesForm = $("examples-form");
const exampleConfirm = $("confirm-example");
const exampleConsent = $("accept-example-license");
const exampleSdkDirectory = examplesForm.elements.namedItem("cubismSdkDirectory");
const exampleEndpoint = "/api/examples/lantern";
let exampleStatus;
let exampleLoading;
let exampleDirectorySelection;
let installingExample = false;

function updateExampleActions() {
  const canOpen = exampleStatus?.available && !["invalid", "external-missing"].includes(exampleStatus.core);
  exampleConfirm.disabled = installingExample || !canOpen
    || (exampleStatus.consentRequired && !exampleConsent.checked)
    || (exampleStatus.modelSourceRequired && !exampleSdkDirectory.value.trim());
  exampleConfirm.textContent = installingExample ? "正在安装并打开…"
    : exampleStatus?.core === "missing" || exampleStatus?.modelSourceRequired ? "安装并打开" : "打开示例";
  $("cancel-example").disabled = installingExample;
  exampleConsent.disabled = installingExample;
  exampleSdkDirectory.disabled = installingExample;
  $("browse-example-sdk").disabled = installingExample || Boolean(exampleLoading || exampleDirectorySelection);
}

function setExampleError(error) {
  const alert = $("example-error");
  alert.textContent = error ? localizedMessage(error) : "";
  alert.hidden = !error;
}

$("open-examples").addEventListener("click", async () => {
  examplesForm.reset();
  exampleStatus = undefined;
  $("example-license").hidden = true;
  $("example-model").hidden = true;
  $("example-missing").hidden = true;
  $("example-status").textContent = "正在检查本机依赖…";
  setExampleError();
  const loading = new AbortController();
  exampleLoading = loading;
  updateExampleActions();
  examplesDialog.showModal();
  try {
    const result = await api(exampleEndpoint, { signal: loading.signal });
    if (loading.signal.aborted) return;
    exampleStatus = result;
    $("examples-heading").textContent = result.title;
    const missing = $("example-missing");
    missing.replaceChildren(...result.missing.map((dependency) => {
      const item = document.createElement("li");
      item.textContent = dependency;
      return item;
    }));
    missing.hidden = missing.childElementCount === 0;
    $("example-status").textContent = !result.available ? "本机暂无法打开此示例。"
      : missing.hidden ? "已找到所需依赖。" : "继续前请处理以下依赖。";
    $("example-model").hidden = !result.available || !result.modelSourceRequired;
    if (result.modelDownloadUrl) $("example-model-download").href = result.modelDownloadUrl;
    $("example-license").hidden = !result.consentRequired;
    $("example-terms").replaceChildren(...result.licenses.map(({ title, url }) => {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = title;
      item.append(link);
      return item;
    }));
  } catch (error) {
    if (!loading.signal.aborted) {
      $("example-status").textContent = "未能检查示例依赖。";
      setExampleError(error);
    }
  } finally {
    if (exampleLoading === loading) {
      exampleLoading = undefined;
      updateExampleActions();
    }
  }
});

examplesDialog.addEventListener("close", () => {
  exampleLoading?.abort();
  exampleDirectorySelection?.abort();
  exampleDirectorySelection = undefined;
});
examplesDialog.addEventListener("cancel", (event) => {
  if (installingExample) event.preventDefault();
});
$("cancel-example").addEventListener("click", () => examplesDialog.close());
exampleConsent.addEventListener("change", updateExampleActions);
exampleSdkDirectory.addEventListener("input", updateExampleActions);
$("browse-example-sdk").addEventListener("click", async () => {
  const selection = new AbortController();
  exampleDirectorySelection = selection;
  updateExampleActions();
  try {
    const result = await api("/api/projects/pick-directory", { method: "POST", body: "{}", signal: selection.signal });
    if (result.path && !selection.signal.aborted) exampleSdkDirectory.value = result.path;
  } catch (error) {
    if (!selection.signal.aborted) setExampleError(error);
  } finally {
    if (exampleDirectorySelection === selection) {
      exampleDirectorySelection = undefined;
      updateExampleActions();
    }
  }
});
examplesForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (exampleConfirm.disabled) return;
  installingExample = true;
  setExampleError();
  updateExampleActions();
  try {
    const result = await api(exampleEndpoint, {
      method: "POST",
      body: JSON.stringify({
        acceptCubismTerms: exampleConsent.checked,
        cubismSdkDirectory: exampleSdkDirectory.value.trim() || undefined,
      }),
    });
    await loadProjects(result.id);
    examplesDialog.close();
    clearNotice();
  } catch (error) {
    setExampleError(error);
  } finally {
    installingExample = false;
    updateExampleActions();
  }
});

$("new-project").addEventListener("click", () => {
  $("create-form").reset();
  renderEcosystemModuleCheckboxes("create-ecosystem-list", "createEcosystemModule", [], false);
  const details = createDialog.querySelector(".create-ecosystem-details");
  if (details) details.open = false;
  createDialog.showModal();
});
$("cancel-create").addEventListener("click", () => createDialog.close());
$("create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const selectedModules = Array.from(
    event.currentTarget.querySelectorAll('#create-ecosystem-list input[type="checkbox"]:checked'),
    (input) => input.value,
  );
  try {
    clearNotice();
    const payload = {
      id: form.get("id"),
      name: form.get("name"),
      directory: form.get("directory") || undefined,
      appId: form.get("appId"),
      template: form.get("template") || "app",
      version: form.get("version"),
      ...(selectedModules.length > 0 ? { ecosystemModules: selectedModules } : {}),
    };
    const result = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    createDialog.close();
    await loadProjects(result.id);
  } catch (error) {
    showNotice(error);
  }
});

$("open-packages-manager")?.addEventListener("click", () => {
  switchInspectorTab("settings");
  const pkgPanel = $("packages-panel");
  if (pkgPanel) {
    pkgPanel.open = true;
    pkgPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  void loadProjectPackages();
});
$("packages-search")?.addEventListener("input", (event) => {
  packagesQuery = String(event.target?.value || "").trim().toLowerCase();
  renderPackagesPanel();
});
$("packages-refresh")?.addEventListener("click", () => {
  void loadProjectPackages({ notify: true });
});
$("packages-category-bar")?.addEventListener("click", (event) => {
  const pill = event.target?.closest?.("[data-pkg-cat]");
  if (!pill) return;
  const nextCat = pill.getAttribute("data-pkg-cat") || "all";
  packagesCategory = nextCat;
  renderPackagesPanel();
});
$("open-ecosystem-builder")?.addEventListener("click", () => {
  const tools = $("editor-tools");
  if (tools) tools.open = true;
  $("ecosystem-panel")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
});

function setInspectorEcosystemSelection(predicate) {
  for (const box of document.querySelectorAll('#ecosystem-module-list input[type="checkbox"]')) {
    box.checked = Boolean(predicate(box));
  }
}

$("ecosystem-preset-apple")?.addEventListener("click", () => {
  setInspectorEcosystemSelection((box) => box.dataset.ecosystem === "apple" || box.checked);
});
$("ecosystem-preset-android")?.addEventListener("click", () => {
  setInspectorEcosystemSelection((box) => box.dataset.ecosystem === "android" || box.checked);
});
$("ecosystem-preset-clear")?.addEventListener("click", () => {
  setInspectorEcosystemSelection(() => false);
});

async function applyProjectEcosystemModules() {
  if (!currentId || ecosystemApplying) return;
  const previousModules = new Set(currentProjectConfig?.ecosystemModules || []);
  const selectedModules = Array.from(
    document.querySelectorAll('#ecosystem-module-list input[type="checkbox"]:checked'),
    (input) => input.value,
  );
  ecosystemApplying = true;
  setEnabled(true);
  try {
    clearNotice();
    if (dirty) await saveProject();
    const result = await api(`/api/projects/${encodeURIComponent(currentId)}/ecosystem`, {
      method: "POST",
      body: JSON.stringify({ modules: selectedModules }),
    });
    currentProjectConfig = result.config || { ...(currentProjectConfig || {}), ecosystemModules: result.modules || selectedModules };
    syncProjectEcosystemUi(currentProjectConfig);
    const filesResponse = await api(`/api/projects/${encodeURIComponent(currentId)}/files`);
    renderFilePicker(filesResponse.files || filesResponse);
    if (currentFile && projectFiles.includes(currentFile)) {
      await loadFile(currentFile);
    }
    if (result.status) renderStatus(result.status);
    const newlyAddedModule = ecosystemModuleCatalog.find(
      (mod) => selectedModules.includes(mod.id) && !previousModules.has(mod.id),
    );
    const picker = $("viewport-picker");
    if (picker && newlyAddedModule && Array.isArray(newlyAddedModule.profileIds) && newlyAddedModule.profileIds[0]) {
      const targetProfile = newlyAddedModule.profileIds[0];
      if (surfaceProfilesById.has(targetProfile) && picker.value === "mobile") {
        picker.value = targetProfile;
        picker.dispatchEvent(new Event("change"));
      }
    }
    await buildProject();
  } catch (error) {
    showNotice(error);
  } finally {
    ecosystemApplying = false;
    setEnabled(Boolean(currentId));
  }
}

$("apply-ecosystem-modules")?.addEventListener("click", () => {
  void applyProjectEcosystemModules();
});

$("save").addEventListener("click", () => { void saveProject().catch(() => {}); });
$("save-config").addEventListener("click", () => { void saveProjectConfig().catch(() => {}); });
$("build").addEventListener("click", () => { void buildProject(); });
$("publish-target-channel")?.addEventListener("change", (event) => {
  void switchPublishTargetChannel(event.currentTarget.value).catch(showNotice);
});
$("publish-target-picker")?.addEventListener("change", (event) => {
  const appId = event.currentTarget.value;
  const target = publishTargets?.targets?.find((entry) => entry.appId === appId);
  if (!target) {
    const sourceProjectId = publishTargetContext?.sourceProjectId;
    const sourceProject = projects.find((project) => project.id === sourceProjectId);
    if (sourceProjectId && currentId !== sourceProjectId && (appId === sourceProjectId || appId === sourceProject?.appId)) {
      void selectProject(sourceProjectId).then(() => {
        if (currentId === sourceProjectId) showNotice(`已返回主应用 ${sourceProject?.name || sourceProject?.appId || sourceProjectId}。`, "info");
        else renderPublishTargetPicker();
      });
      return;
    }
    renderPublishTargetPicker();
    return;
  }
  if (target.kind !== "reused") {
    const sourceProjectId = publishTargetContext?.sourceProjectId;
    if (sourceProjectId && target.projectId === sourceProjectId && currentId !== sourceProjectId) {
      void selectProject(sourceProjectId).then(() => {
        if (currentId === sourceProjectId) showNotice(`已返回主应用项目 ${target.appId}。`, "info");
        else renderPublishTargetPicker();
      });
      return;
    }
    renderPublishTargetPicker();
    return;
  }
  if (target.canSelect === false || !target.ownerProjectId) {
    showNotice(target.reason || `无法解析 ${target.appId} 的所属项目。`, "error");
    renderPublishTargetPicker();
    return;
  }
  const ownerProjectId = target.ownerProjectId;
  const context = {
    sourceProjectId: publishTargets?.currentProjectId || currentId,
    sourceProjectTitle: target.sourceProjectTitle || projects.find((project) => project.id === publishTargets?.currentProjectId)?.name || publishTargets?.currentProjectId || currentId,
    sourcePath: target.sourcePath || "",
    appId: target.appId,
    ownerProjectId,
    ownerTitle: target.ownerTitle || target.title || ownerProjectId,
  };
  void selectProject(ownerProjectId, { publishTargetContext: context }).then(() => {
    if (currentId !== ownerProjectId) {
      renderPublishTargetPicker();
      return;
    }
    const sourceLabel = target.sourcePath
      ? `${context.sourceProjectTitle} 内 MiniApp ${target.title || target.appId}（${target.sourcePath}）`
      : `MiniApp ${target.title || target.appId} 的源码 ${target.ownerTitle || ownerProjectId}`;
    showNotice(`已打开 ${sourceLabel}。当前编辑、预览、构建和发布均针对该源码；可从项目列表返回主应用。`, "info");
  });
});
$("publish-test").addEventListener("click", () => { void publishProject(publishTargetChannel); });
$("open-version-manager-from-signing")?.addEventListener("click", () => $("versions-open")?.click());
$("version-app-config-copy")?.addEventListener("click", () => {
  const button = $("version-app-config-copy");
  const url = $("version-app-config-link")?.getAttribute("href");
  if (button && url) void copyVersionUrl(url, button, "App 接入地址");
});
$("cos-detect")?.addEventListener("click", () => {
  void detectLocalCos();
});
$("cos-toggle-settings")?.addEventListener("click", () => {
  cosSettingsOpen = !cosSettingsOpen;
  renderCosPanel();
});
$("cos-bucket-preset")?.addEventListener("change", (event) => {
  const val = event.currentTarget.value || "";
  const atIdx = val.lastIndexOf("@");
  if (atIdx > 0) {
    const bucket = val.slice(0, atIdx);
    const region = val.slice(atIdx + 1);
    if ($("cos-bucket")) $("cos-bucket").value = bucket;
    if ($("cos-region")) $("cos-region").value = region;
  }
});
$("cos-enabled")?.addEventListener("change", async (event) => {
  const wantEnabled = event.currentTarget.checked;
  const snap = cosSnapshot || versionSnapshot?.cos || null;
  const local = snap?.local || { available: false };
  const fields = readCosFormFields();
  if (wantEnabled) {
    const hasPendingCreds = Boolean($("cos-secret-id")?.value?.trim() && $("cos-secret-key")?.value?.trim());
    if ((!local.available && !hasPendingCreds) || !fields.bucket || !fields.region) {
      event.currentTarget.checked = false;
      cosSettingsOpen = true;
      renderCosPanel();
      showNotice("开启 COS 发布前，请先确认本机密钥并填写存储桶（Bucket-APPID）与地域（Region）。", "info");
      return;
    }
    const updated = await saveCosConfig({ enabled: true });
    if (updated?.config?.enabled) {
      showNotice(`已开启腾讯云 COS 发布（${updated.config.bucket}）。`, "success");
    }
  } else {
    const updated = await saveCosConfig({ enabled: false });
    if (updated) {
      showNotice("已关闭腾讯云 COS 发布。", "info");
    }
  }
});
$("cos-check-connection")?.addEventListener("click", () => {
  void checkCosConnection();
});
$("cos-save-config")?.addEventListener("click", async () => {
  const updated = await saveCosConfig();
  if (updated) {
    showNotice("腾讯云 COS 配置已保存。", "success");
  }
});
$("cos-clear-credentials")?.addEventListener("click", async () => {
  const updated = await saveCosConfig({ credentials: null });
  if (updated) {
    showNotice("已清除 Studio 保存的本机 COS 密钥。", "info");
  }
});
$("cos-publish-test")?.addEventListener("click", () => {
  void publishToCos("test");
});
$("cos-publish-stable")?.addEventListener("click", () => {
  void publishToCos("release");
});
$("version-cos-app-config-copy")?.addEventListener("click", () => {
  const button = $("version-cos-app-config-copy");
  const url = $("version-cos-app-config-link")?.getAttribute("href");
  if (button && url) void copyVersionUrl(url, button, "COS 接入地址");
});
$("cf-detect")?.addEventListener("click", () => {
  void loadCloudflareConfig({ notify: true });
});
$("cf-toggle-settings")?.addEventListener("click", () => {
  cfSettingsOpen = !cfSettingsOpen;
  renderCloudflarePanel();
});
$("cf-enabled")?.addEventListener("change", (event) => {
  const enabled = Boolean(event.target?.checked);
  if (enabled && collectCloudflareTargetsPayload().length === 0) {
    cfSettingsOpen = true;
    renderCloudflarePanel();
    showNotice("请先配置至少一条 Cloudflare R2 账户路由并保存矩阵配置。", "error");
    if ($("cf-enabled")) $("cf-enabled").checked = false;
    return;
  }
  void saveCloudflareMatrixConfig({ overrideEnabled: enabled });
});
$("cf-save-profile")?.addEventListener("click", () => {
  void saveCloudflareProfile();
});
$("cf-sync-on-publish")?.addEventListener("change", () => {
  cfMatrixDirty = true;
});
$("cf-purge-on-publish")?.addEventListener("change", () => {
  cfMatrixDirty = true;
});
$("cf-add-target")?.addEventListener("click", () => {
  const defaultProfileId = cfSnapshot?.local?.profiles?.[0]?.profileId || "";
  cfTargetDrafts.push(
    cloneCloudflareTargetDraft({
      profileId: defaultProfileId,
      keyPrefix: currentId ? `apps/${currentId}` : "",
      platforms: ["*"],
      role: cfTargetDrafts.length === 0 ? "primary" : "fallback",
    }),
  );
  cfMatrixDirty = true;
  renderCloudflareTargetsList();
  updateCloudflareActionStates();
});
$("cf-save-config")?.addEventListener("click", () => {
  void saveCloudflareMatrixConfig();
});
$("cf-publish-test")?.addEventListener("click", () => {
  void publishToCloudflare("test");
});
$("cf-publish-stable")?.addEventListener("click", () => {
  void publishToCloudflare("release");
});
$("version-cf-app-config-copy")?.addEventListener("click", () => {
  const button = $("version-cf-app-config-copy");
  const url = $("version-cf-app-config-link")?.getAttribute("href");
  if (button && url) void copyVersionUrl(url, button, "Cloudflare 接入地址");
});
$("versions-open").addEventListener("click", () => {
  switchInspectorTab("versions");
});
$("versions-refresh").addEventListener("click", () => { void loadVersions(); });
for (const [tab, sel] of [
  ["versions", "#version-manager > summary"],
  ["resources", "#resources-panel > summary"],
  ["settings", "#editor-tools > summary"],
]) {
  document.querySelector(sel)?.addEventListener("click", (event) => {
    const details = event.currentTarget?.parentElement;
    if (!(details instanceof HTMLDetailsElement)) return;
    if (details.open) {
      // It is about to close!
      const othersOpen = ["resources-panel", "version-manager", "editor-tools"]
        .filter((id) => id !== details.id)
        .some((id) => $(id)?.open);
      if (!othersOpen) {
        clearInspectorActiveUi();
      }
    } else {
      syncInspectorAccordion(tab);
    }
  });
}
$("version-manager").addEventListener("toggle", (event) => {
  handleInspectorPanelToggle("versions", event.currentTarget);
});
$("resources-panel")?.addEventListener("toggle", (event) => {
  handleInspectorPanelToggle("resources", event.currentTarget);
});
$("editor-tools")?.addEventListener("toggle", (event) => {
  handleInspectorPanelToggle("settings", event.currentTarget);
});
$("refresh-preview").addEventListener("click", () => { void refreshPreview(); });
$("preview-open").addEventListener("click", () => { if (previewPath) window.open(previewBrowserUrl().href, "_blank", "noopener"); });
$("clear-log").addEventListener("click", () => { logEl.textContent = ""; });
$("refresh-source").addEventListener("click", refreshSourceFromServer);
$("file-picker").addEventListener("change", async (event) => {
  const nextFile = event.currentTarget.value;
  if (dirty && !window.confirm("放弃未保存的源文件修改？")) {
    event.currentTarget.value = currentFile;
    return;
  }
  try { clearNotice(); await loadFile(nextFile); } catch (error) { showNotice(error); }
});
$("resource-package-picker").addEventListener("change", (event) => {
  const nextPackage = event.currentTarget.value;
  selectResourcePackage(nextPackage);
});
$("save-resources").addEventListener("click", () => { void saveResources().catch(() => {}); });
sourceEl.addEventListener("input", () => markDirty());
for (const id of PROJECT_CONFIG_INPUTS) {
  $(id).addEventListener("input", () => {
    updateConfigSaveFeedback();
    updateActionStates();
  });
}
$("viewport-picker").addEventListener("change", (event) => setViewport(event.currentTarget.value));
$("surface-render-mode")?.addEventListener("change", (event) => {
  currentSurfaceRenderMode = event.currentTarget.value;
  syncSurfaceToolbarControls();
  resizePreviewRuntime();
});
$("widget-companion-jump")?.addEventListener("click", () => {
  const profile = activeSurfaceProfile();
  const companionId = profile?.companionDeviceId;
  const picker = $("viewport-picker");
  if (!profile || !companionId || !picker || !surfaceProfilesById.has(companionId)) return;
  const primaryHref = latestWidgetSnapshot?.hotspots?.[0]?.href || `pocket://showcase/ecosystem?from=${encodeURIComponent(profile.id)}`;
  picker.value = companionId;
  setViewport(companionId, { openUri: primaryHref });
});
const previewBezelToggle = $("preview-bezel-toggle");
if (previewBezelToggle) {
  previewBezelToggle.setAttribute("aria-pressed", String(previewBezelEnabled));
  previewBezelToggle.addEventListener("click", (event) => {
    previewBezelEnabled = !previewBezelEnabled;
    event.currentTarget.setAttribute("aria-pressed", String(previewBezelEnabled));
    try {
      localStorage.setItem(PREVIEW_BEZEL_STORAGE_KEY, previewBezelEnabled ? "1" : "0");
    } catch {}
    updatePreviewBezelPresentation();
  });
}
const webBluetoothToggle = $("web-bluetooth-toggle");
const bluetoothProviderPicker = $("bluetooth-provider");
function updateBluetoothSettings() {
  bluetoothProvider = "local";
  nobleBluetoothSupported = localBluetoothAvailable;
  if (webBluetoothToggle) {
    webBluetoothToggle.checked = webBluetoothEnabled;
    webBluetoothToggle.disabled = !nobleBluetoothSupported;
  }
  if (bluetoothProviderPicker) {
    bluetoothProviderPicker.hidden = true;
    bluetoothProviderPicker.value = "local";
  }
  setText("bluetooth-provider-label", "Noble 蓝牙");
  setText("web-bluetooth-help", nobleBluetoothSupported
    ? "使用本机 @abandonware/noble 适配器。请在宿主项目中安装，然后请求蓝牙权限并扫描 BLE。"
    : "请在宿主项目中安装 @abandonware/noble，并在 macOS 或 Windows 上运行编辑器。");
}
if (webBluetoothToggle) {
  updateBluetoothSettings();
  webBluetoothToggle.addEventListener("change", () => {
    webBluetoothEnabled = webBluetoothToggle.checked && nobleBluetoothSupported;
    try { localStorage.setItem(NOBLE_BLUETOOTH_STORAGE_KEY, webBluetoothEnabled ? "1" : "0"); } catch {}
    sendPreviewPlugins();
  });
}
bluetoothProviderPicker?.addEventListener("change", () => {
  bluetoothProvider = "local";
  updateBluetoothSettings();
  sendPreviewPlugins();
});
$("capture-preview").addEventListener("click", async () => {
  try {
    const capture = await capturePreview();
    downloadPreviewCapture(capture);
    showNotice("预览截图已下载。", "success");
  } catch (error) { showNotice(error); }
});
$("preview-gpu-toggle")?.addEventListener("click", () => {
  if (!previewGpuAvailable || !currentId) return;
  previewGpuRequested = !previewGpuActive;
  try {
    localStorage.setItem(PREVIEW_GPU_STORAGE_PREFIX + currentId, previewGpuRequested ? "1" : "0");
  } catch {}
  void refreshPreview();
});
$("toggle-regions")?.addEventListener("click", (event) => {
  previewRegionsEnabled = !previewRegionsEnabled;
  event.currentTarget.setAttribute("aria-pressed", String(previewRegionsEnabled));
  sendPreviewRegions();
});
$("copy-preview-link")?.addEventListener("click", () => { void copyPreviewLink(); });

$("device-picker").addEventListener("change", () => updateActionStates());
$("deploy").addEventListener("click", () => { void deployProject(); });
$("deploy-cancel").addEventListener("click", () => { void cancelDeploy(); });
$("wechat-start")?.addEventListener("click", () => { void startWechat(); });
$("wechat-stop")?.addEventListener("click", () => { void stopWechat(); });
setupPreviewHeightControl();

const sourceDock = $("source-dock");
const consoleDock = $("console-dock");

function clearInspectorActiveUi() {
  syncInspectorAccordion(null);
}

function syncInspectorAccordion(activeTab) {
  const resourcesPanel = $("resources-panel");
  const versionManager = $("version-manager");
  const editorTools = $("editor-tools");
  if (activeTab === "resources") {
    if (versionManager?.open) versionManager.open = false;
    if (editorTools?.open) editorTools.open = false;
  } else if (activeTab === "versions") {
    if (resourcesPanel?.open) resourcesPanel.open = false;
    if (editorTools?.open) editorTools.open = false;
  } else if (activeTab === "settings") {
    if (resourcesPanel?.open) resourcesPanel.open = false;
    if (versionManager?.open) versionManager.open = false;
  }
  const tabMap = {
    resources: $("inspector-tab-resources"),
    versions: $("inspector-tab-versions"),
    settings: $("inspector-tab-settings"),
  };
  for (const [key, btn] of Object.entries(tabMap)) {
    if (!btn) continue;
    const selected = key === activeTab;
    btn.classList.toggle("active", selected);
    btn.setAttribute("aria-selected", String(selected));
  }
  const railMap = {
    resources: $("rail-resources"),
    versions: $("rail-versions"),
    settings: $("rail-settings"),
  };
  for (const [key, btn] of Object.entries(railMap)) {
    if (!btn) continue;
    const selected = key === activeTab;
    btn.classList.toggle("active", selected);
    btn.setAttribute("aria-pressed", String(selected));
  }
}

function handleInspectorPanelToggle(tab, panel) {
  if (!panel) return;
  if (panel.open) {
    syncInspectorAccordion(tab);
    if (tab === "versions" && !versionSnapshot) void loadVersions();
    if (tab === "settings" && !packagesSnapshot) void loadProjectPackages();
  } else if (!$("resources-panel")?.open && !$("version-manager")?.open && !$("editor-tools")?.open) {
    clearInspectorActiveUi();
  }
}

function switchInspectorTab(tab) {
  const resourcesPanel = $("resources-panel");
  const versionManager = $("version-manager");
  const editorTools = $("editor-tools");
  if (tab === "resources" && resourcesPanel) {
    if (versionManager) versionManager.open = false;
    if (editorTools) editorTools.open = false;
    resourcesPanel.open = true;
    syncInspectorAccordion("resources");
    resourcesPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } else if (tab === "versions" && versionManager) {
    if (resourcesPanel) resourcesPanel.open = false;
    if (editorTools) editorTools.open = false;
    versionManager.open = true;
    syncInspectorAccordion("versions");
    versionManager.scrollIntoView({ behavior: "smooth", block: "nearest" });
    void loadVersions();
  } else if (tab === "settings" && editorTools) {
    if (resourcesPanel) resourcesPanel.open = false;
    if (versionManager) versionManager.open = false;
    editorTools.open = true;
    syncInspectorAccordion("settings");
    editorTools.scrollIntoView({ behavior: "smooth", block: "nearest" });
    if (!packagesSnapshot) void loadProjectPackages();
  }
}

function toggleSourceDock(force) {
  if (!sourceDock) return;
  const nextOpen = typeof force === "boolean" ? force : sourceDock.hidden;
  sourceDock.hidden = !nextOpen;
  for (const id of ["source-split-toggle", "rail-source"]) {
    const btn = $(id);
    if (btn) {
      btn.classList.toggle("active", nextOpen);
      btn.setAttribute("aria-pressed", String(nextOpen));
    }
  }
  if (nextOpen && sourceEl && !sourceEl.disabled) {
    sourceEl.focus();
  }
  requestAnimationFrame(() => layoutPreviewFrame());
}

function switchConsoleTab(tabKey) {
  for (const btn of document.querySelectorAll("[data-console-tab]")) {
    const active = btn.dataset.consoleTab === tabKey;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", String(active));
  }
  for (const pane of document.querySelectorAll("[data-console-pane]")) {
    pane.hidden = pane.dataset.consolePane !== tabKey;
  }
  if (consoleDock?.classList.contains("collapsed")) {
    toggleConsoleDock(false);
  }
}

function toggleConsoleDock(forceCollapsed) {
  if (!consoleDock) return;
  const collapsed = typeof forceCollapsed === "boolean"
    ? forceCollapsed
    : !consoleDock.classList.contains("collapsed");
  consoleDock.classList.toggle("collapsed", collapsed);
  const consoleCollapseToggle = $("console-collapse-toggle");
  if (consoleCollapseToggle) {
    consoleCollapseToggle.setAttribute("aria-expanded", String(!collapsed));
  }
  const railConsole = $("rail-console");
  if (railConsole) {
    railConsole.classList.toggle("active", !collapsed);
    railConsole.setAttribute("aria-pressed", String(!collapsed));
  }
  requestAnimationFrame(() => layoutPreviewFrame());
}

for (const btn of document.querySelectorAll("[data-console-tab]")) {
  btn.addEventListener("click", () => switchConsoleTab(btn.dataset.consoleTab));
}
$("console-collapse-toggle")?.addEventListener("click", () => toggleConsoleDock());
$("rail-console")?.addEventListener("click", () => toggleConsoleDock());

$("inspector-tab-resources")?.addEventListener("click", () => switchInspectorTab("resources"));
$("inspector-tab-versions")?.addEventListener("click", () => switchInspectorTab("versions"));
$("inspector-tab-settings")?.addEventListener("click", () => switchInspectorTab("settings"));

$("rail-stage")?.addEventListener("click", () => {
  previewStageWrap?.scrollIntoView({ behavior: "smooth", block: "nearest" });
});
$("rail-source")?.addEventListener("click", () => toggleSourceDock());
$("rail-resources")?.addEventListener("click", () => switchInspectorTab("resources"));
$("rail-versions")?.addEventListener("click", () => $("versions-open")?.click());
$("rail-settings")?.addEventListener("click", () => switchInspectorTab("settings"));

$("novel-open")?.addEventListener("click", () => {
  if (currentId) window.open(`/novel?project=${encodeURIComponent(currentId)}`, "_blank", "noopener");
});
$("source-toggle")?.addEventListener("click", () => {
  const options = document.querySelector(".preview-options");
  if (options instanceof HTMLDetailsElement) options.open = false;
  toggleSourceDock(true);
});
$("source-split-toggle")?.addEventListener("click", () => toggleSourceDock());
$("source-close")?.addEventListener("click", () => toggleSourceDock(false));

window.addEventListener("keydown", (event) => {
  if (event.defaultPrevented) return;
  if (createDialog?.open || Boolean(document.querySelector("dialog[open], #novel-studio-modal:not([hidden])"))) return;
  if (!(event.metaKey || event.ctrlKey)) return;
  const key = event.key.toLowerCase();
  if (key === "s") {
    event.preventDefault();
    if (!$("save")?.disabled) $("save")?.click();
    else void saveProject().catch(() => {});
  } else if (key === "b") {
    if (!$("build")?.disabled) {
      event.preventDefault();
      $("build")?.click();
    }
  } else if (key === "j") {
    event.preventDefault();
    toggleConsoleDock();
  } else if (key === "e") {
    if (!$("source-split-toggle")?.disabled) {
      event.preventDefault();
      toggleSourceDock();
    }
  }
});
window.addEventListener("beforeunload", (event) => {
  if (dirty || resourcesDirty) {
    event.preventDefault();
    event.returnValue = "";
  }
});

function stopStudioUpgradePolling() {
  if (studioUpgradePollTimer) {
    clearTimeout(studioUpgradePollTimer);
    studioUpgradePollTimer = null;
  }
}

function isStudioUpgradeWorkDeferred() {
  return Boolean(
    dirty ||
    resourcesDirty ||
    saving ||
    resourcesSaving ||
    publishing ||
    startingDeploy ||
    startingWechat ||
    currentStatus?.busy ||
    wechatState?.state === "building" ||
    (activeDeploy && ["queued", "building", "starting", "stopping"].includes(String(activeDeploy.status || "").toLowerCase()))
  );
}

function resumeDeferredStudioUpgrade() {
  if (isStudioUpgradeWorkDeferred()) {
    if (studioUpgradeState) renderStudioUpgrade(studioUpgradeState);
    return;
  }
  if (studioUpgradePendingReloadVersion) {
    studioUpgradePendingReloadVersion = null;
    window.location.reload();
    return;
  }
  if (studioUpgradeDeferredAutoApply) {
    studioUpgradeDeferredAutoApply = false;
    void checkStudioUpgrade({ autoApply: true });
  } else if (studioUpgradeState) {
    renderStudioUpgrade(studioUpgradeState);
  }
}

function formatStudioUpgradeBytes(value) {
  const bytes = Number.isSafeInteger(value) && value >= 0 ? value : 0;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let scaled = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && scaled >= 1024; index += 1) {
    scaled /= 1024;
    unit = units[index];
  }
  return `${scaled >= 10 ? scaled.toFixed(0) : scaled.toFixed(1)} ${unit}`;
}

function renderStudioUpgrade(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return;
  studioUpgradeState = { ...(studioUpgradeState || {}), ...snapshot };
  const bar = $("studio-upgrade-bar");
  const modeEl = $("studio-upgrade-mode");
  const versionEl = $("studio-upgrade-version");
  const statusEl = $("studio-upgrade-status");
  const reasonEl = $("studio-upgrade-reason");
  const progressEl = $("studio-upgrade-progress");
  const progressFill = $("studio-upgrade-progress-fill");
  const progressText = $("studio-upgrade-progress-text");
  const actionBtn = $("studio-upgrade-action");
  const releaseLink = $("studio-upgrade-release");
  if (!bar || !versionEl || !statusEl || !actionBtn) return;

  const currentVersion = studioUpgradeState.currentVersion || "—";
  const latestVersion = studioUpgradeState.latestVersion || "";
  const status = studioUpgradeState.status || "idle";
  const upgradeAvailable = Boolean(studioUpgradeState.upgradeAvailable);
  const autoUpgradeSupported = studioUpgradeState.autoUpgradeSupported === true;
  const error = studioUpgradeState.error || "";
  const deferredReason = studioUpgradeState.deferredReason || "";
  const releaseUrl = studioUpgradeState.releaseUrl || "";
  const isInProgress = ["downloading", "applying", "restarting"].includes(status);
  const localDraftReason = dirty
    ? "编辑器有未保存修改；保存后可继续自动升级。"
    : resourcesDirty
      ? "资源策略有未保存修改；保存后可继续自动升级。"
      : "";
  const isDeferred = autoUpgradeSupported && upgradeAvailable && !isInProgress && Boolean(deferredReason || localDraftReason);
  const reasonText = deferredReason || (
    upgradeAvailable && !isInProgress && localDraftReason
      ? localDraftReason
      : !autoUpgradeSupported
        ? studioUpgradeState.modeReason || "当前安装方式不支持自动升级。"
        : ""
  );

  if (modeEl) {
    modeEl.textContent = !autoUpgradeSupported
      ? "自动升级不可用"
      : isDeferred
        ? "自动升级已暂缓"
        : "自动升级已开启";
    modeEl.dataset.state = !autoUpgradeSupported ? "unsupported" : isDeferred ? "deferred" : "enabled";
    modeEl.title = reasonText || modeEl.textContent;
  }

  versionEl.textContent = upgradeAvailable && latestVersion
    ? `v${currentVersion} → v${latestVersion}`
    : `v${currentVersion}`;

  if (releaseLink) {
    if (releaseUrl && /^https?:\/\//i.test(releaseUrl)) {
      releaseLink.href = releaseUrl;
      releaseLink.hidden = false;
    } else {
      releaseLink.hidden = true;
    }
  }

  let statusText = "等待检查更新";
  let tone = "";
  let buttonLabel = "检查更新";
  let buttonDisabled = false;

  if (studioUpgradePendingReloadVersion) {
    statusText = `已升级至 v${studioUpgradePendingReloadVersion}（保存未保存修改后将自动刷新页面）`;
    tone = "warn";
    buttonLabel = "立即刷新";
    buttonDisabled = false;
  } else if (status === "checking") {
    statusText = "正在检查 GitHub 稳定版更新…";
    tone = "warn";
    buttonLabel = "检查中…";
    buttonDisabled = true;
  } else if (status === "downloading") {
    statusText = `正在下载 v${studioUpgradeState.targetVersion || latestVersion} 升级包…`;
    tone = "warn";
    buttonLabel = "升级中…";
    buttonDisabled = true;
  } else if (status === "applying") {
    statusText = `下载完成（${formatStudioUpgradeBytes(studioUpgradeState.downloadedBytes)}），正在校验并暂存 v${studioUpgradeState.targetVersion || latestVersion}…`;
    tone = "warn";
    buttonLabel = "升级中…";
    buttonDisabled = true;
  } else if (status === "restarting") {
    statusText = `正在应用 v${studioUpgradeState.targetVersion || latestVersion} 并重启 Studio…`;
    tone = "warn";
    buttonLabel = "重启中…";
    buttonDisabled = true;
  } else if (status === "error") {
    statusText = error || "升级检查失败";
    tone = "bad";
    buttonLabel = autoUpgradeSupported && upgradeAvailable ? "重试升级" : "重试检查";
  } else if (upgradeAvailable) {
    if (!autoUpgradeSupported) {
      statusText = `发现新版本 v${latestVersion}`;
      tone = "warn";
      buttonLabel = "重新检查";
    } else if (deferredReason) {
      statusText = `发现新版本 v${latestVersion}`;
      tone = "warn";
      buttonLabel = "重新检查";
    } else if (dirty || resourcesDirty) {
      statusText = `发现新版本 v${latestVersion}`;
      tone = "warn";
      buttonLabel = "保存后升级";
    } else {
      statusText = `发现新版本 v${latestVersion}`;
      tone = "warn";
      buttonLabel = "立即升级";
    }
  } else if (status === "up-to-date") {
    if (latestVersion && latestVersion !== currentVersion) {
      statusText = `无可用升级；最新已发布稳定版 v${latestVersion}`;
      if (!autoUpgradeSupported) statusText += "（当前安装方式不支持自动升级）";
    } else {
      statusText = autoUpgradeSupported ? "已是最新稳定版" : "已是最新稳定版（当前安装方式不支持自动升级）";
    }
    tone = "good";
    buttonLabel = "检查更新";
  }

  if (tone) bar.dataset.state = tone;
  else delete bar.dataset.state;
  statusEl.textContent = statusText;
  statusEl.title = statusText;
  if (reasonEl) {
    reasonEl.textContent = reasonText;
    reasonEl.hidden = !reasonText || isInProgress;
    reasonEl.title = reasonText;
  }
  if (progressEl && progressFill && progressText) {
    const isDownloading = status === "downloading";
    progressEl.hidden = !isDownloading;
    if (isDownloading) {
      const downloadedBytes = Number.isSafeInteger(studioUpgradeState.downloadedBytes) && studioUpgradeState.downloadedBytes >= 0
        ? studioUpgradeState.downloadedBytes
        : 0;
      const totalBytes = Number.isSafeInteger(studioUpgradeState.downloadTotalBytes) && studioUpgradeState.downloadTotalBytes > 0
        ? studioUpgradeState.downloadTotalBytes
        : null;
      const determinate = totalBytes !== null && downloadedBytes <= totalBytes;
      if (determinate) {
        const percent = Math.min(100, Math.floor(downloadedBytes / totalBytes * 100));
        progressFill.style.width = `${percent}%`;
        delete progressFill.dataset.indeterminate;
        progressEl.setAttribute("aria-valuenow", String(percent));
        progressEl.setAttribute("aria-valuetext", `${percent}%，${formatStudioUpgradeBytes(downloadedBytes)} / ${formatStudioUpgradeBytes(totalBytes)}`);
        progressText.textContent = `${formatStudioUpgradeBytes(downloadedBytes)} / ${formatStudioUpgradeBytes(totalBytes)} · ${percent}%`;
      } else {
        progressFill.style.width = "35%";
        progressFill.dataset.indeterminate = "true";
        progressEl.removeAttribute("aria-valuenow");
        progressEl.setAttribute("aria-valuetext", `已接收 ${formatStudioUpgradeBytes(downloadedBytes)}`);
        progressText.textContent = `已接收 ${formatStudioUpgradeBytes(downloadedBytes)}`;
      }
    } else {
      progressFill.style.width = "0";
      delete progressFill.dataset.indeterminate;
      progressEl.removeAttribute("aria-valuenow");
      progressEl.removeAttribute("aria-valuetext");
      progressText.textContent = "";
    }
  }
  actionBtn.textContent = buttonLabel;
  actionBtn.disabled = buttonDisabled;
}

async function pollStudioRestart(targetVersion, previousVersion, attempt = 0) {
  stopStudioUpgradePolling();
  if (attempt > 120) {
    renderStudioUpgrade({
      status: "error",
      error: `等待 Studio 重启到 v${targetVersion} 超时，请手动检查服务状态。`,
    });
    return;
  }
  try {
    const response = await fetch("/health", {
      cache: "no-store",
      headers: { "x-pocket-editor": "1" },
      signal: AbortSignal.timeout(1500),
    });
    if (response.ok) {
      const health = await response.json();
      if (health?.ok === true && health.service === "pocket-editor") {
        if (health.csrfToken) csrfToken = health.csrfToken;
        if (health.version === targetVersion) {
          if (dirty || resourcesDirty) {
            studioUpgradePendingReloadVersion = targetVersion;
            renderStudioUpgrade({
              currentVersion: targetVersion,
              latestVersion: targetVersion,
              status: "up-to-date",
              upgradeAvailable: false,
              error: null,
            });
            return;
          }
          renderStudioUpgrade({
            currentVersion: targetVersion,
            latestVersion: targetVersion,
            status: "up-to-date",
            upgradeAvailable: false,
            error: null,
          });
          window.location.reload();
          return;
        }
        if (attempt >= 2 && health.version === previousVersion) {
          const latestStatus = await api("/api/studio/upgrade").catch(() => null);
          if (latestStatus && latestStatus.status === "error") {
            renderStudioUpgrade(latestStatus);
            if (latestStatus.error) showNotice(latestStatus.error, "error");
            return;
          }
        }
      }
    }
  } catch {
    // Server is mid-restart; continue polling.
  }
  studioUpgradePollTimer = setTimeout(() => {
    void pollStudioRestart(targetVersion, previousVersion, attempt + 1);
  }, 350);
}

async function checkStudioUpgrade({ autoApply = true, forceApply = false } = {}) {
  if (studioUpgradePollTimer) return null;
  let checkPending = true;
  const pollCheckStatus = async () => {
    if (!checkPending) return;
    try {
      const snapshot = await api("/api/studio/upgrade", {
        cache: "no-store",
        signal: AbortSignal.timeout(2000),
      });
      if (checkPending && snapshot && typeof snapshot === "object") {
        renderStudioUpgrade(snapshot.status === "available"
          ? { ...snapshot, status: "checking" }
          : snapshot);
      }
    } catch {
      // Keep the latest visible phase while the check request continues.
    }
    if (checkPending) {
      studioUpgradePollTimer = setTimeout(() => {
        void pollCheckStatus();
      }, 250);
    }
  };
  try {
    const deferAutoApply = autoApply && !forceApply && isStudioUpgradeWorkDeferred();
    renderStudioUpgrade({ status: "checking", error: null });
    const previousVersion = studioUpgradeState?.currentVersion;
    studioUpgradePollTimer = setTimeout(() => {
      void pollCheckStatus();
    }, 150);
    const result = await api("/api/studio/upgrade/check", {
      method: "POST",
      body: JSON.stringify({ autoApply: deferAutoApply ? false : autoApply, forceApply }),
    });
    checkPending = false;
    stopStudioUpgradePolling();
    studioUpgradeDeferredAutoApply = Boolean(
      result?.upgradeAvailable &&
      result?.autoUpgradeSupported === true &&
      (deferAutoApply || result?.deferredReason)
    );
    renderStudioUpgrade(result);
    if (result?.status === "restarting" || result?.status === "applying" || result?.status === "downloading") {
      studioUpgradeDeferredAutoApply = false;
      const targetVersion = result.targetVersion || result.latestVersion;
      if (targetVersion) {
        void pollStudioRestart(targetVersion, previousVersion || result.currentVersion);
      }
    } else if (result?.status === "error" && result.rolledBack && result.error) {
      showNotice(result.error, "error");
    }
    return result;
  } catch (error) {
    checkPending = false;
    stopStudioUpgradePolling();
    if (studioUpgradeState?.status === "restarting") {
      const targetVersion = studioUpgradeState.targetVersion || studioUpgradeState.latestVersion;
      if (targetVersion) {
        void pollStudioRestart(targetVersion, studioUpgradeState.currentVersion || "");
        return null;
      }
    }
    renderStudioUpgrade({ status: "error", error: normalizeError(error).message });
    return null;
  }
}

function startPeriodicStudioUpgradeChecks() {
  if (studioUpgradePeriodicTimer) clearInterval(studioUpgradePeriodicTimer);
  studioUpgradePeriodicTimer = setInterval(() => {
    if (studioUpgradePollTimer || studioUpgradePendingReloadVersion) return;
    if (["checking", "downloading", "applying", "restarting"].includes(studioUpgradeState?.status)) return;
    void checkStudioUpgrade({ autoApply: true });
  }, STUDIO_UPGRADE_CHECK_INTERVAL_MS);
}

$("studio-upgrade-action")?.addEventListener("click", () => {
  if (studioUpgradePendingReloadVersion) {
    if ((dirty || resourcesDirty) && !window.confirm("当前仍有未保存修改，立即刷新会丢弃草稿，是否继续？")) return;
    studioUpgradePendingReloadVersion = null;
    window.location.reload();
    return;
  }
  if ((dirty || resourcesDirty) && studioUpgradeState?.autoUpgradeSupported === true && studioUpgradeState?.upgradeAvailable) {
    studioUpgradeDeferredAutoApply = true;
    renderStudioUpgrade(studioUpgradeState);
    showNotice("请先保存源文件或资源策略修改，保存后将自动升级。", "info");
    return;
  }
  const upgradeAvailable = Boolean(studioUpgradeState?.upgradeAvailable);
  const forceApply = studioUpgradeState?.autoUpgradeSupported === true && upgradeAvailable;
  void checkStudioUpgrade({ autoApply: true, forceApply });
});

// The runner owns the mobile device profile. Load it before selecting a
// project so Canvas and WeChat keep the same logical screen and safe-area
// contract. The Studio update check is independent of that device request.
void loadPreviewDevice()
  .then(() => Promise.all([loadProjects(), loadDevices()]))
  .catch(showNotice);
void checkStudioUpgrade({ autoApply: true })
  .then(() => startPeriodicStudioUpgradeChecks());
