/**
 * render_svg tool definition + dual-path routing.
 *
 * Shared preamble (validate → rasterize → capability resolve) then:
 *   Path A (multimodal): return PNG as a ToolResult attachment, no ctx.ask().
 *   Path B (human):      write cache, best-effort open(), block on ctx.ask().
 */
import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "@opencode-ai/plugin"
import open from "open"
import DESCRIPTION from "./render_svg.txt" with { type: "text" }
import { validateSvg } from "./validate.ts"
import { rasterizeSvg } from "./rasterize.ts"
import { cachePaths, writeCache } from "./cache.ts"
import { summarizeSvg } from "./summarize.ts"
import type { ResolvedRenderSvgOptions } from "./config.ts"

export type ModelLike = {
  capabilities?: {
    input?: {
      image?: boolean
    }
  }
}

export type RenderSvgDeps = {
  /** Defaults to reading the plugin's session→model cache. */
  getModel?: (sessionID: string) => ModelLike | undefined
  /** Defaults to the `open` package. Injected in tests. */
  openFile?: (path: string) => Promise<void>
  /** Defaults to a per-process incrementing counter. Injected in tests. */
  nextCallSuffix?: () => string
}

let callCounter = 0
const defaultNextCallSuffix = (): string => {
  callCounter += 1
  return String(callCounter).padStart(3, "0")
}

const defaultOpenFile = async (path: string): Promise<void> => {
  await open(path)
}

export function isMultimodalModel(model: ModelLike | undefined): boolean {
  return model?.capabilities?.input?.image === true
}

export function createRenderSvgTool(options: ResolvedRenderSvgOptions, deps: RenderSvgDeps = {}) {
  const getModel = deps.getModel ?? (() => undefined)
  const openFile = deps.openFile ?? defaultOpenFile
  const nextCallSuffix = deps.nextCallSuffix ?? defaultNextCallSuffix

  return tool({
    description: DESCRIPTION.trim(),
    args: {
      svg: tool.schema.string().describe(
        "Complete, self-contained SVG markup (must start with <svg ...> and be well-formed XML). " +
          "Do not reference external files, fonts, or URLs.",
      ),
      title: tool.schema.string().optional().describe("Short human-readable title for this render."),
      width: tool.schema
        .number()
        .int()
        .positive()
        .max(4096)
        .optional()
        .describe("Rasterization width in px. Defaults to the SVG's intrinsic width or 1024."),
      height: tool.schema.number().int().positive().max(4096).optional(),
      background: tool.schema.enum(["transparent", "white"]).optional(),
    },
    async execute(args, ctx: ToolContext) {
      ctx.metadata({ title: args.title ?? "Rendering SVG" })

      // 1. Validate & sanitize (throws model-correctable ValidateError).
      const sanitized = validateSvg(args.svg, {
        maxSvgBytes: options.maxSvgBytes,
        maxPixels: options.maxPixels,
        width: args.width,
        height: args.height,
      })

      // 2. Rasterize (throws RenderError on failure; no partial attachments).
      const background = args.background ?? options.defaultBackground
      const png = await rasterizeSvg(sanitized, {
        width: args.width,
        height: args.height,
        background,
      })

      // 3. Resolve capability + override.
      const model = getModel(ctx.sessionID)
      const useHumanPath = options.forceHumanReview || !isMultimodalModel(model)

      const callID = `${ctx.messageID}-${nextCallSuffix()}`
      const paths = cachePaths(ctx.worktree, ctx.sessionID, callID, options.cacheDir)

      // Path A — multimodal self-review.
      if (!useHumanPath) {
        // Best-effort audit cache; a cache failure must not fail the render.
        let cachePath: string | undefined
        try {
          await writeCache(paths, sanitized, png.bytes)
          cachePath = paths.png
        } catch {
          cachePath = undefined
        }
        return {
          title: args.title ?? "Rendered SVG",
          output:
            `Rendered a ${png.width}x${png.height} PNG from the provided SVG. ` +
            `Review the attached image and continue iterating if anything looks wrong.`,
          metadata: {
            svgBytes: args.svg.length,
            width: png.width,
            height: png.height,
            ...(cachePath !== undefined ? { cachePath } : {}),
          },
          attachments: [
            { type: "file" as const, mime: "image/png", url: `data:image/png;base64,${png.base64}` },
          ],
        }
      }

      // Path B — human review.
      await writeCache(paths, sanitized, png.bytes)
      if (options.autoOpenViewer) {
        await openFile(paths.png).catch(() => {})
      }
      const summary = summarizeSvg(sanitized)

      // Rejections (RejectedError / CorrectedError) propagate as-is; the
      // framework surfaces err.message to the model as the tool error.
      await ctx.ask({
        permission: "render_svg",
        patterns: [paths.png],
        always: ["*"],
        metadata: {
          title: args.title ?? "SVG render awaiting review",
          cachePath: paths.png,
          summary,
          preview: `data:image/png;base64,${png.base64}`,
        },
      })

      return {
        title: args.title ?? "Rendered SVG (approved)",
        output: `Render approved by user. Saved to ${paths.svg}. ${summary}`,
        metadata: { cachePath: paths.svg, width: png.width, height: png.height },
      }
    },
  })
}

export type RenderSvgTool = ReturnType<typeof createRenderSvgTool>
