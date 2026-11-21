import { MOBILE_THEME_DARK, type MobileTheme } from "@pocket/ui";

/**
 * Exact Web Preview (`sdk/editor/client/editor.css`) Desktop IDE Workbench color tokens.
 * Note: Never use `"transparent"` in PocketJS native inline styles; use `"#00000000"` or omit.
 */
export const C = {
  // Surface hierarchy
  bg: "#090B0F",
  bgRaised: "#0D1016",
  rail: "#0D1016",
  panel: "#11151D",
  surface: "#11151D",
  surface2: "#171C27",
  surface3: "#1F2635",
  hover: "#171C27",
  stageHud: "#0C0F15",
  stageDevice: "#06080C",
  stageEmptyTop: "#111622",
  stageEmptyBottom: "#0B0E15",

  // Hairlines & Borders
  border: "#232A38",
  line: "#232A38",
  lineSoft: "#1A202C",
  lineHover: "#344056",
  deviceBorder: "#2E384B",

  // Typography
  text: "#EDF2FB",
  body: "#CBD5E1",
  muted: "#8B96AB",
  faint: "#5D677A",

  // Accents & Semantic States
  primary: "#3B82F6",
  primaryHover: "#2563EB",
  primarySoft: "#12213B",
  primaryBorder: "#274C85",
  info: "#60A5FA",
  blue: "#60A5FA",

  ok: "#34D399",
  okStrong: "#10B981",
  okSoft: "#0E231E",
  okBorder: "#1D5242",

  warn: "#FBBF24",
  warnSoft: "#261E0D",
  warnBorder: "#574217",

  danger: "#FB7185",
  dangerSoft: "#28131B",
  dangerBorder: "#5E2435",

  cfSoft: "#26170E",
  cfBorder: "#5A3015",
} as const;

/** Custom MobileTheme aligning @pocket/ui InputField, Switch, SegmentedControl, Dialog, and ToastHost with Web Preview. */
export const STUDIO_MOBILE_THEME: MobileTheme = {
  ...MOBILE_THEME_DARK,
  name: "dark",
  canvas: "bg-[#090B0F]",
  surface: "bg-[#11151D]",
  surfaceMuted: "bg-[#171C27]",
  surfaceElevated: "bg-[#11151D]",
  ink: "text-[#EDF2FB]",
  muted: "text-[#8B96AB]",
  accent: "bg-[#3B82F6]",
  accentPressed: "bg-[#2563EB]",
  accentSoft: "bg-[#172554]",
  accentInk: "text-[#93C5FD]",
  accentColor: 0xff3b82f6,
  accentSoftColor: 0xff172554,
  accentInkColor: 0xff93c5fd,
  accentPressedColor: 0xff2563eb,
  border: "border-[#232A38]",
  danger: "bg-[#E11D48]",
  success: "bg-[#10B981]",
  warning: "bg-[#D97706]",
};

/** The Studio shell is dark-only; the code editor follows it. */
export const CODE_THEME = "dark" as const;

/** Breakpoint at or above which all 5 desktop workbench zones coexist simultaneously side-by-side. */
export const WIDE_WORKBENCH_MIN_WIDTH = 1160;
