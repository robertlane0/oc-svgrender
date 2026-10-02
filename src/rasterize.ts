/**
 * Rasterization wrapper around @resvg/resvg-wasm.
 *
 * Deterministic, offline, no network fetches. External image refs are never
 * resolved (validator rejects them first; anything slipping through renders
 * blank rather than triggering a fetch).
 */
import { initWasm, Resvg } from "@resvg/resvg-wasm"

export class RenderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RenderError"
  }
}

export type PngResult = {
  bytes: Uint8Array
  width: number
  height: number
  base64: string
}

export type RasterizeOpts = {
  width?: number
  height?: number
  background: "white" | "transparent"
}

/**
 * `initWasm()` may be called exactly once per process, but this module can be
 * evaluated several times in one process: OpenCode reloads a local plugin's
 * module graph whenever a watched source file changes, and each evaluation
 * gets a fresh binding while `@resvg/resvg-wasm` stays a singleton underneath.
 * The memo therefore lives on `globalThis` under a well-known key, so a reloaded
 * copy joins the first initialization instead of racing it.
 */
const WASM = Symbol.for("opencode-plugin-render-svg/resvg-wasm")

type WasmScope = { [WASM]?: Promise<void> }

function ensureWasm(): Promise<void> {
  const scope = globalThis as WasmScope
  const existing = scope[WASM]
  if (existing) return existing
  const pending = (async () => {
    const { readFile } = await import("node:fs/promises")
    const { createRequire } = await import("node:module")
    const require = createRequire(import.meta.url)
    const wasmPath = require.resolve("@resvg/resvg-wasm/index_bg.wasm")
    const bytes = await readFile(wasmPath)
    try {
      await initWasm(bytes)
    } catch (error) {
      // Something else already initialized the module: that state is shared and
      // usable, so this is a success rather than a failure.
      if (!/already initialized/i.test(error instanceof Error ? error.message : String(error))) throw error
    }
  })()
  scope[WASM] = pending
  // Allow a later call to retry initialization after a genuine failure.
  pending.catch(() => {
    if (scope[WASM] === pending) delete scope[WASM]
  })
  return pending
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength).toString("base64")
}

export async function rasterizeSvg(svg: string, opts: RasterizeOpts): Promise<PngResult> {
  try {
    await ensureWasm()
  } catch (err) {
    throw new RenderError(
      `SVG render failed: renderer initialization failed (${err instanceof Error ? err.message : String(err)})`,
    )
  }

  // fitTo: explicit width wins; else explicit height; else intrinsic/zoom 1.
  // resvg preserves aspect ratio for single-dimension fitTo.
  const fitTo =
    opts.width !== undefined
      ? { mode: "width" as const, value: opts.width }
      : opts.height !== undefined
        ? { mode: "height" as const, value: opts.height }
        : { mode: "zoom" as const, value: 1 }

  let resvg: InstanceType<typeof Resvg> | undefined
  try {
    resvg = new Resvg(svg, {
      fitTo,
      background: opts.background === "white" ? "white" : "rgba(0, 0, 0, 0)",
      font: { loadSystemFonts: false },
    })
    const image = resvg.render()
    const bytes = image.asPng()
    const result: PngResult = {
      bytes,
      width: image.width,
      height: image.height,
      base64: toBase64(bytes),
    }
    image.free()
    return result
  } catch (err) {
    throw new RenderError(`SVG render failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    resvg?.free()
  }
}
