// Asset policy shared by the upload state and the resources page. The service and the provider enforce the real
// rules; these give early, readable refusals before a file is read.
import { extension } from "./path.ts";

/** Flat, safe file name: the service's own pattern. */
export const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const MAX_ASSET_BYTES = 32 * 1024 * 1024;

export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"] as const;
export const AUDIO_EXTENSIONS = ["wav", "mp3", "ogg", "m4a", "aac", "flac"] as const;
export const FONT_EXTENSIONS = ["ttf", "otf", "woff", "woff2"] as const;
/** What the open dialog offers. */
export const ASSET_EXTENSIONS: readonly string[] = [...IMAGE_EXTENSIONS, ...AUDIO_EXTENSIONS, ...FONT_EXTENSIONS];
/** The host's codecs decode these; SVG is an image that the host cannot rasterize. */
export const DECODABLE_IMAGE_EXTENSIONS: readonly string[] = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];

export type AssetKind = "image" | "audio" | "font" | "other";
export function assetKind(name: string): AssetKind {
  const ext = extension(name);
  if ((IMAGE_EXTENSIONS as readonly string[]).includes(ext)) return "image";
  if ((AUDIO_EXTENSIONS as readonly string[]).includes(ext)) return "audio";
  if ((FONT_EXTENSIONS as readonly string[]).includes(ext)) return "font";
  return "other";
}
export const KIND_LABEL: Record<AssetKind, string> = { image: "图片", audio: "音频", font: "字体", other: "文件" };

/** A message when `name` cannot become an asset file name, else undefined. */
export function validateAssetName(name: string): string | undefined {
  if (!ASSET_NAME.test(name)) return "文件名不安全：只允许字母、数字、点、下划线和连字符，且以字母或数字开头（最长 128 个字符）。请先重命名文件。";
  if (!(ASSET_EXTENSIONS as readonly string[]).includes(extension(name))) return `不支持的文件类型：仅支持 ${ASSET_EXTENSIONS.join("、")}。`;
  return undefined;
}

/** Why an asset has no preview (undefined: it can be decoded). */
export function previewBlocker(name: string): string | undefined {
  const ext = extension(name);
  if (ext === "svg") return "SVG 无法由宿主解码，没有预览。";
  if (!(IMAGE_EXTENSIONS as readonly string[]).includes(ext)) return "此类型不是图片，没有预览。";
  return undefined;
}
