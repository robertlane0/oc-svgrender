import { describe, expect, test } from "bun:test"
import { rasterizeSvg, RenderError } from "../src/rasterize.ts"

const RED_RECT =
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>'

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47]

describe("rasterizeSvg", () => {
  test("renders 100x100 red rect to valid PNG", async () => {
    const png = await rasterizeSvg(RED_RECT, { background: "white" })
    expect([...png.bytes.slice(0, 4)]).toEqual(PNG_MAGIC)
    expect(png.width).toBe(100)
    expect(png.height).toBe(100)
    expect(png.base64.length).toBeGreaterThan(100)
    // base64 round-trips to the same magic bytes
    const decoded = Buffer.from(png.base64, "base64")
    expect([...decoded.slice(0, 4)]).toEqual(PNG_MAGIC)
  })

  test("width override scales output", async () => {
    const png = await rasterizeSvg(RED_RECT, { background: "white", width: 50 })
    expect(png.width).toBe(50)
    expect(png.height).toBe(50)
  })

  test("transparent vs white backgrounds differ", async () => {
    // Mostly-empty canvas so the background shows through.
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="10" fill="red"/></svg>'
    const white = await rasterizeSvg(svg, { background: "white" })
    const transparent = await rasterizeSvg(svg, { background: "transparent" })
    expect(Buffer.from(white.bytes).equals(Buffer.from(transparent.bytes))).toBe(false)
  })

  test("invalid SVG throws RenderError", async () => {
    await expect(rasterizeSvg("not svg at all {{{", { background: "white" })).rejects.toBeInstanceOf(
      RenderError,
    )
  })

  test("no network fetch on external image ref (renders blank, does not throw/fetch)", async () => {
    let fetched = false
    const origFetch = globalThis.fetch
    // @ts-expect-error - stub fetch
    globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
      fetched = true
      return origFetch(...args)
    }
    try {
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50">' +
        '<image href="https://example.com/x.png" width="50" height="50"/></svg>'
      const png = await rasterizeSvg(svg, { background: "white" })
      expect(png.width).toBe(50)
      expect(fetched).toBe(false)
    } finally {
      globalThis.fetch = origFetch
    }
  })
})
