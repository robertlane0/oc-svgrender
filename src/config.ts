/**
 * Plugin options and defaults for render_svg.
 *
 * Mirrors PLUGIN.md §8. Options arrive via `Plugin(input, options)` and are
 * merged once at plugin init; `execute` closes over the resolved copy.
 */

export type RenderSvgOptions = {
  maxSvgBytes?: number
  maxPixels?: number
  defaultBackground?: "white" | "transparent"
  autoOpenViewer?: boolean
  forceHumanReview?: boolean
  cacheDir?: string
}

export type ResolvedRenderSvgOptions = {
  maxSvgBytes: number
  maxPixels: number
  defaultBackground: "white" | "transparent"
  autoOpenViewer: boolean
  forceHumanReview: boolean
  cacheDir: string
}

export const DEFAULTS = {
  maxSvgBytes: 256_000,
  maxPixels: 4_000_000,
  defaultBackground: "white",
  autoOpenViewer: true,
  forceHumanReview: false,
  cacheDir: ".opencode/render-svg",
} as const satisfies Record<keyof Required<Omit<ResolvedRenderSvgOptions, never>>, unknown>

const VALID_BACKGROUNDS = new Set(["white", "transparent"])

export function resolveOptions(raw?: unknown): ResolvedRenderSvgOptions {
  const o = (raw ?? {}) as RenderSvgOptions
  const maxSvgBytes =
    typeof o.maxSvgBytes === "number" && Number.isFinite(o.maxSvgBytes) && o.maxSvgBytes > 0
      ? Math.floor(o.maxSvgBytes)
      : DEFAULTS.maxSvgBytes
  const maxPixels =
    typeof o.maxPixels === "number" && Number.isFinite(o.maxPixels) && o.maxPixels > 0
      ? Math.floor(o.maxPixels)
      : DEFAULTS.maxPixels
  const defaultBackground: "white" | "transparent" =
    o.defaultBackground === "transparent" || o.defaultBackground === "white"
      ? o.defaultBackground
      : DEFAULTS.defaultBackground
  if (o.defaultBackground !== undefined && !VALID_BACKGROUNDS.has(o.defaultBackground)) {
    // Fall through to default; unknown values must not crash plugin init.
  }
  return {
    maxSvgBytes,
    maxPixels,
    defaultBackground,
    autoOpenViewer: typeof o.autoOpenViewer === "boolean" ? o.autoOpenViewer : DEFAULTS.autoOpenViewer,
    forceHumanReview:
      typeof o.forceHumanReview === "boolean" ? o.forceHumanReview : DEFAULTS.forceHumanReview,
    cacheDir: typeof o.cacheDir === "string" && o.cacheDir.length > 0 ? o.cacheDir : DEFAULTS.cacheDir,
  }
}
