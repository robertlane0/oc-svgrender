/**
 * render_svg tool definition (OpenCode v2 promise plugin API).
 *
 * V2 shape notes, all of them load-bearing:
 *  - a tool is a plain value: `{ name, description, input, options, execute }`
 *    registered through `ctx.tool.transform((editor) => editor.add(tool))`;
 *  - `execute` is async and MUST NOT reject. The promise adapter runs it inside
 *    `Effect.promise`, so a thrown error becomes a defect that kills the step
 *    instead of a model-readable tool result. Every failure below is returned as
 *    text;
 *  - there is no `output` schema, so the result carries `content` (what the
 *    model reads, including image parts) and `metadata` (UI-only; never sent to
 *    the model);
 *  - `options.permission` is the action name a `deny` rule in `opencode.json`
 *    must match to take the tool out of the catalog.
 *
 * Two routes for the same render:
 *   Path A (multimodal model): the PNG rides along as a `file` content part, so
 *     the model sees its own render on the next turn and can iterate.
 *   Path B (text-only model, or `forceHumanReview`): no image is attached —
 *     OpenCode rewrites an image part into an "this model does not support
 *     image input" error for text-only models, which is worse than saying
 *     nothing. The render goes to the workspace cache, the OS viewer opens it,
 *     and the model gets a structural summary plus the file path.
 *
 * V1 gated Path B on `ctx.ask()`. V2 gives plugins no permission-prompt API
 * (`ctx.permission` is list/get/reply only), so the blocking approve/reject
 * dialog is gone: gating is a config concern, see README.
 */
import type { Info as ToolInfo, Result as ToolResult, ToolContext } from "@opencode/plugin/promise/tool"
import open from "open"
import DESCRIPTION from "./render_svg.txt" with { type: "text" }
import { validateSvg } from "./validate.ts"
import { rasterizeSvg } from "./rasterize.ts"
import { cachePaths, writeCache } from "./cache.ts"
import { summarizeSvg } from "./summarize.ts"
import type { ResolvedRenderSvgOptions } from "./config.ts"

export const TOOL_NAME = "render_svg"
/** The `opencode.json` permission action for this tool. */
export const PERMISSION = "render_svg"

export type Result = ToolResult<undefined>

export type RenderSvgInput = {
  svg: string
  title?: string
  width?: number
  height?: number
  background?: "white" | "transparent"
}

export type RenderSvgDeps = {
  options: ResolvedRenderSvgOptions
  /** `ctx.location.directory`; the render cache is rooted here. */
  directory: string
  /** Whether the session's model can read an image. Missing ⇒ false. */
  acceptsImage: (sessionID: string) => Promise<boolean>
  /** Defaults to the `open` package. Injected in tests. */
  openFile?: (path: string) => Promise<unknown>
  /** Defaults to a per-process counter, appended to the tool call id. */
  nextCallSuffix?: () => string
}

const MAX_EDGE = 4096

/**
 * Plain JSON Schema. V2 hands a tool's `input` to the model verbatim, so this
 * object is the entire schema layer — no zod, no effect Schema, and therefore no
 * second copy of either library that the host's `instanceof` checks could
 * disagree with. `additionalProperties: false` because the host decodes the
 * schema into a struct: an unknown key is a model mistake worth reporting.
 */
export const input = {
  type: "object",
  properties: {
    svg: {
      type: "string",
      description:
        "Complete, self-contained SVG markup (must start with <svg ...> and be well-formed XML). Do not reference external files, fonts, or URLs.",
    },
    title: { type: "string", description: "Short human-readable title for this render." },
    width: {
      type: "integer",
      minimum: 1,
      maximum: MAX_EDGE,
      description: "Rasterization width in px. Defaults to the SVG's intrinsic width or 1024.",
    },
    height: {
      type: "integer",
      minimum: 1,
      maximum: MAX_EDGE,
      description: "Rasterization height in px. Defaults to the SVG's intrinsic height or 1024.",
    },
    background: {
      type: "string",
      enum: ["transparent", "white"],
      description: "PNG background. Defaults to the plugin's defaultBackground.",
    },
  },
  required: ["svg"],
  additionalProperties: false,
} as const

let callCounter = 0
const defaultNextCallSuffix = (): string => {
  callCounter += 1
  return String(callCounter).padStart(3, "0")
}

/** `wait: false` so a viewer that never exits cannot stall the tool call. */
const defaultOpenFile = async (path: string): Promise<unknown> => open(path, { wait: false })

export function createRenderSvgTool(deps: RenderSvgDeps): ToolInfo<any, undefined> {
  const openFile = deps.openFile ?? defaultOpenFile
  const nextCallSuffix = deps.nextCallSuffix ?? defaultNextCallSuffix

  return {
    name: TOOL_NAME,
    description: DESCRIPTION.trim(),
    input,
    options: { codemode: false, permission: PERMISSION },
    async execute(raw, ctx: ToolContext): Promise<Result> {
      return render(raw, ctx, { ...deps, openFile, nextCallSuffix })
    },
  }
}

async function render(raw: unknown, ctx: ToolContext, deps: Required<RenderSvgDeps>): Promise<Result> {
  const parsed = parseInput(raw)
  if (!parsed.ok) return text(parsed.message)

  const args = parsed.value
  const { options } = deps
  // Progress is best effort: a client that stopped listening must not fail a render.
  await progress(ctx, { title: args.title ?? "Rendering SVG" })

  let sanitized: string
  let png: { bytes: Uint8Array; width: number; height: number; base64: string }
  try {
    sanitized = validateSvg(args.svg, {
      maxSvgBytes: options.maxSvgBytes,
      maxPixels: options.maxPixels,
      width: args.width,
      height: args.height,
    })
    png = await rasterizeSvg(sanitized, {
      width: args.width,
      height: args.height,
      background: args.background ?? options.defaultBackground,
    })
  } catch (err) {
    return text(errorText(err))
  }

  const summary = summarizeSvg(sanitized)
  const callID = `${String(ctx.id)}-${deps.nextCallSuffix()}`
  const paths = cachePaths(deps.directory, ctx.sessionID, callID, options.cacheDir)
  const name = `${sanitizeTitle(args.title) ?? "render"}-${png.width}x${png.height}.png`
  // The cache is an audit trail on Path A and the human's copy on Path B, so a
  // write failure downgrades the result but never fails the render.
  const cached = await writeCache(paths, sanitized, png.bytes).then(
    () => true,
    () => false,
  )

  const useHumanPath = options.forceHumanReview || !(await deps.acceptsImage(ctx.sessionID))

  if (useHumanPath) {
    if (options.autoOpenViewer) await deps.openFile(paths.png).catch(() => {})
    return text(
      [
        `Rendered a ${png.width}x${png.height} PNG to ${paths.png} and opened it in an image viewer for human review.`,
        "You cannot see images, so judge the artwork from this structural summary and keep iterating on the markup:",
        summary,
        cached ? `Source markup: ${paths.svg}` : "Source markup was not cached (cache write failed).",
      ].join("\n"),
      metadata({
        title: args.title,
        route: "human",
        width: png.width,
        height: png.height,
        bytes: png.bytes.byteLength,
        png: paths.png,
        svg: cached ? paths.svg : undefined,
        summary,
        // UI-only channel: clients that render tool metadata can show the render
        // without the model ever seeing it.
        preview: `data:image/png;base64,${png.base64}`,
      }),
    )
  }

  return {
    content: [
      {
        type: "text",
        text:
          `Rendered a ${png.width}x${png.height} PNG from the provided SVG. ` +
          `Review the attached image and continue iterating if anything looks wrong.`,
      },
      {
        type: "file",
        uri: `data:image/png;base64,${png.base64}`,
        mime: "image/png",
        name,
      },
    ],
    metadata: metadata({
      title: args.title,
      route: "multimodal",
      width: png.width,
      height: png.height,
      bytes: png.bytes.byteLength,
      png: paths.png,
      svg: cached ? paths.svg : undefined,
      summary,
    }),
  }
}

/**
 * Tool metadata is encoded as `Record<string, Json>` on the
 * `session.tool.success` event, and an explicit `undefined` value fails that
 * encode: the event never publishes, the tool result is lost, and the model
 * only sees "Provider did not return a tool result". Drop the key instead.
 */
function metadata(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined))
}

export type ParsedInput = { ok: true; value: RenderSvgInput } | { ok: false; message: string }

export function parseInput(raw: unknown): ParsedInput {
  const fail = (message: string): ParsedInput => ({ ok: false, message })
  if (typeof raw !== "object" || raw === null) {
    return fail(`render_svg: expected an object of arguments, received ${typeof raw}. Call the tool again with { "svg": "…" }.`)
  }
  const value = raw as Record<string, unknown>
  if (typeof value["svg"] !== "string" || value["svg"].trim().length === 0) {
    return fail('render_svg: `svg` is required and must be a non-empty string of <svg> markup. Call the tool again with { "svg": "<svg …>…</svg>" }.')
  }
  const title = value["title"]
  if (title !== undefined && typeof title !== "string") {
    return fail("render_svg: `title` must be a string when provided.")
  }
  const width = edge(value["width"], "width")
  if (!width.ok) return fail(width.message)
  const height = edge(value["height"], "height")
  if (!height.ok) return fail(height.message)
  const background = value["background"]
  if (background !== undefined && background !== "white" && background !== "transparent") {
    return fail('render_svg: `background` must be "white" or "transparent".')
  }
  return {
    ok: true,
    value: {
      svg: value["svg"],
      ...(title !== undefined ? { title } : {}),
      ...(width.value !== undefined ? { width: width.value } : {}),
      ...(height.value !== undefined ? { height: height.value } : {}),
      ...(background !== undefined ? { background } : {}),
    },
  }
}

type Edge = { ok: true; value?: number } | { ok: false; message: string }

function edge(value: unknown, name: string): Edge {
  if (value === undefined) return { ok: true }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_EDGE) {
    return { ok: false, message: `render_svg: \`${name}\` must be an integer between 1 and ${MAX_EDGE} pixels.` }
  }
  return { ok: true, value }
}

function sanitizeTitle(title: string | undefined): string | undefined {
  if (title === undefined) return undefined
  const cleaned = title.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)
  return cleaned.length > 0 ? cleaned : undefined
}

function text(body: string, metadata?: Record<string, unknown>): Result {
  return { content: body, ...(metadata === undefined ? {} : { metadata }) }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return `render_svg: ${String(error)}`
}

async function progress(ctx: ToolContext, update: Record<string, unknown>): Promise<void> {
  try {
    await ctx.progress?.(update)
  } catch {
    /* the UI is not listening; the result is what matters */
  }
}

