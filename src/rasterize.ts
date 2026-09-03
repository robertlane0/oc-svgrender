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

let wasmReady: Promise<void> | undefined

function ensureWasm(): Promise<void> {
  if (!wasmReady) {
    wasmReady = (async () => {
      const { readFile } = await import("node:fs/promises")
      const { createRequire } = await import("node:module")
      const require = createRequire(import.meta.url)
      const wasmPath = require.resolve("@resvg/resvg-wasm/index_bg.wasm")
      const bytes = await readFile(wasmPath)
      await initWasm(bytes)
    })()
    // Allow retry after failure: reset the cached promise on rejection.
    wasmReady.catch(() => {
      wasmReady = undefined
    })
  }
  return wasmReady
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
    throw new RenderError(
      `SVG render failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  } finally {
    resvg?.free()
  }
}
