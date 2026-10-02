import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { Schema } from "effect"
import { resolveOptions } from "../src/config.ts"
import type { RenderSvgOptions } from "../src/config.ts"
import { createRenderSvgTool, input, parseInput, PERMISSION, TOOL_NAME } from "../src/render_svg.ts"

const VALID =
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>'

let suffix = 0

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionID: "ses-test" as ToolContext["sessionID"],
    agent: "build" as ToolContext["agent"],
    messageID: "msg-test" as ToolContext["messageID"],
    id: "call-1" as ToolContext["id"],
    progress: async () => {},
    signal: new AbortController().signal,
    ...overrides,
  }
}

async function freshDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "render-svg-tool-"))
}

function makeTool(
  options: RenderSvgOptions,
  acceptsImage: boolean,
  directory: string,
  opened: string[] = [],
) {
  return createRenderSvgTool({
    options: resolveOptions(options),
    directory,
    acceptsImage: async () => acceptsImage,
    openFile: async (p) => {
      opened.push(p)
    },
    nextCallSuffix: () => `t${(suffix += 1)}`,
  })
}

type Content = { type: string; text?: string; uri?: string; mime?: string; name?: string }

function partsOf(result: { content?: string | readonly Content[] }): Content[] {
  return typeof result.content === "string" ? [{ type: "text", text: result.content }] : [...(result.content ?? [])]
}

function textOf(result: { content?: string | readonly Content[] }): string {
  return partsOf(result)
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
}

function imagesOf(result: { content?: string | readonly Content[] }): Content[] {
  return partsOf(result).filter((part) => part.type === "file")
}

describe("tool definition", () => {
  test("registers as render_svg with a model-callable catalog entry", async () => {
    const tool = makeTool({}, true, await freshDir())
    expect(tool.name).toBe(TOOL_NAME)
    expect(tool.options?.codemode).toBe(false)
    expect(tool.options?.permission).toBe(PERMISSION)
    expect(tool.description.length).toBeGreaterThan(0)
  })

  test("input is plain JSON Schema requiring only svg", () => {
    expect(input.required).toEqual(["svg"])
    expect(input.additionalProperties).toBe(false)
    expect(input.properties.background.enum).toEqual(["transparent", "white"])
  })
})

describe("parseInput", () => {
  test("rejects a missing or non-string svg", () => {
    expect(parseInput({}).ok).toBe(false)
    expect(parseInput({ svg: "  " }).ok).toBe(false)
    expect(parseInput("nope").ok).toBe(false)
    expect(parseInput({ svg: VALID }).ok).toBe(true)
  })

  test("rejects out-of-range edges and unknown backgrounds with actionable text", () => {
    const width = parseInput({ svg: VALID, width: 9000 })
    expect(width.ok).toBe(false)
    expect(width.ok === false && width.message).toContain("width")
    const background = parseInput({ svg: VALID, background: "black" })
    expect(background.ok === false && background.message).toContain("transparent")
  })

  test("keeps optional fields", () => {
    const parsed = parseInput({ svg: VALID, title: "t", width: 10, background: "white" })
    expect(parsed.ok && parsed.value).toEqual({ svg: VALID, title: "t", width: 10, background: "white" })
  })
})

describe("render_svg routing", () => {
  test("Path A: multimodal attaches the PNG and never opens a viewer", async () => {
    const directory = await freshDir()
    const opened: string[] = []
    const tool = makeTool({}, true, directory, opened)
    const result = await tool.execute({ svg: VALID, title: "smoke" }, makeCtx())
    const images = imagesOf(result)
    expect(images.length).toBe(1)
    expect(images[0]?.mime).toBe("image/png")
    expect(images[0]?.uri?.startsWith("data:image/png;base64,")).toBe(true)
    expect(Buffer.from(images[0]!.uri!.split(",")[1]!, "base64").subarray(0, 4)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    )
    expect(textOf(result)).toMatch(/continue iterating/i)
    const metadata = result.metadata as Record<string, unknown>
    expect(metadata["route"]).toBe("multimodal")
    expect(metadata["width"]).toBe(100)
    expect(opened).toEqual([])
    expect((await stat(String(metadata["png"]))).isFile()).toBe(true)
    expect(await readFile(String(metadata["svg"]), "utf8")).toBe(VALID)
  })

  test("Path B: text-only model gets a path and summary, no image, viewer opened", async () => {
    const directory = await freshDir()
    const opened: string[] = []
    const tool = makeTool({}, false, directory, opened)
    const result = await tool.execute({ svg: VALID }, makeCtx())
    expect(imagesOf(result).length).toBe(0)
    const body = textOf(result)
    const metadata = result.metadata as Record<string, unknown>
    expect(body).toContain(String(metadata["png"]))
    expect(body).toContain("cannot see images")
    expect(body).toContain("1 <rect>")
    expect(metadata["route"]).toBe("human")
    expect(opened).toEqual([String(metadata["png"])])
    expect(String(metadata["preview"]).startsWith("data:image/png;base64,")).toBe(true)
    expect((await stat(String(metadata["svg"]))).isFile()).toBe(true)
  })

  test("forceHumanReview routes a multimodal model to Path B", async () => {
    const directory = await freshDir()
    const tool = makeTool({ forceHumanReview: true }, true, directory)
    const result = await tool.execute({ svg: VALID }, makeCtx())
    expect(imagesOf(result).length).toBe(0)
    expect((result.metadata as Record<string, unknown>)["route"]).toBe("human")
  })

  test("autoOpenViewer=false skips the viewer but still caches", async () => {
    const directory = await freshDir()
    const opened: string[] = []
    const tool = makeTool({ autoOpenViewer: false }, false, directory, opened)
    const result = await tool.execute({ svg: VALID }, makeCtx())
    expect(opened).toEqual([])
    expect((await stat(String((result.metadata as Record<string, unknown>)["png"]))).isFile()).toBe(true)
  })

  test("a failing viewer is swallowed", async () => {
    const directory = await freshDir()
    const tool = createRenderSvgTool({
      options: resolveOptions({}),
      directory,
      acceptsImage: async () => false,
      openFile: async () => {
        throw new Error("no viewer here")
      },
      nextCallSuffix: () => "v1",
    })
    const result = await tool.execute({ svg: VALID }, makeCtx())
    expect((result.metadata as Record<string, unknown>)["route"]).toBe("human")
  })

  test("invalid SVG returns model-correctable text without rendering or opening", async () => {
    const directory = await freshDir()
    const opened: string[] = []
    const tool = makeTool({}, true, directory, opened)
    const result = await tool.execute(
      { svg: '<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>' },
      makeCtx(),
    )
    expect(textOf(result)).toMatch(/script/i)
    expect(imagesOf(result).length).toBe(0)
    expect(opened).toEqual([])
    expect(result.metadata).toBeUndefined()
  })

  test("bad arguments resolve as text instead of rejecting", async () => {
    const tool = makeTool({}, true, await freshDir())
    await expect(tool.execute({ width: 3 }, makeCtx())).resolves.toMatchObject({ content: expect.any(String) })
  })

  test("rasterize failure resolves as text instead of rejecting", async () => {
    const tool = createRenderSvgTool({
      options: resolveOptions({ maxSvgBytes: 10 }),
      directory: await freshDir(),
      acceptsImage: async () => true,
      nextCallSuffix: () => "r1",
    })
    const result = await tool.execute({ svg: VALID }, makeCtx())
    expect(textOf(result)).toMatch(/exceeding the 10 byte limit/)
  })

  test("cache write failure still returns the render", async () => {
    const tool = createRenderSvgTool({
      options: resolveOptions({ cacheDir: "/proc/definitely-not-writable" }),
      directory: process.cwd(),
      acceptsImage: async () => true,
      nextCallSuffix: () => "c1",
    })
    const result = await tool.execute({ svg: VALID }, makeCtx())
    expect(imagesOf(result).length).toBe(1)
    const metadata = result.metadata as Record<string, unknown>
    expect(metadata["svg"]).toBeUndefined()
    expect(String(metadata["png"])).toContain("/proc/definitely-not-writable")
  })

  test("metadata never carries undefined (the host encodes it as Json)", async () => {
    // Regression: an explicit `undefined` in metadata fails the
    // `session.tool.success` encode, so the tool result is dropped and the model
    // sees "Provider did not return a tool result" instead of the render.
    const directory = await freshDir()
    const encoded = Schema.encodeUnknownSync(Schema.Record(Schema.String, Schema.Json))
    for (const accepts of [true, false]) {
      const tool = makeTool({}, accepts, directory)
      const result = await tool.execute({ svg: VALID }, makeCtx())
      const values = Object.values((result.metadata ?? {}) as Record<string, unknown>)
      expect(values.some((value) => value === undefined)).toBe(false)
      expect(() => encoded(result.metadata)).not.toThrow()
    }
  })

  test("call ids keep concurrent renders in separate files", async () => {
    const directory = await freshDir()
    const tool = makeTool({}, true, directory)
    const first = await tool.execute({ svg: VALID }, makeCtx({ id: "call-a" as ToolContext["id"] }))
    const second = await tool.execute({ svg: VALID }, makeCtx({ id: "call-a" as ToolContext["id"] }))
    const a = (first.metadata as Record<string, unknown>)["png"]
    const b = (second.metadata as Record<string, unknown>)["png"]
    expect(a).not.toBe(b)
    await rm(directory, { recursive: true, force: true })
  })
})
