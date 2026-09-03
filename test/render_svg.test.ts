import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ToolContext } from "@opencode-ai/plugin"
import { resolveOptions } from "../src/config.ts"
import { createRenderSvgTool } from "../src/render_svg.ts"

const VALID =
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>'

const MULTIMODAL = { capabilities: { input: { image: true } } }
const TEXT_ONLY = { capabilities: { input: { image: false } } }

let suffix = 0

function makeCtx(overrides: Partial<ToolContext> & { worktree: string }): ToolContext {
  const { worktree, ...rest } = overrides
  return {
    sessionID: "ses-test",
    messageID: "msg-test",
    agent: "build",
    directory: worktree,
    worktree,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
    ...rest,
  }
}

async function freshWorktree(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "render-svg-tool-"))
}

describe("render_svg routing", () => {
  test("Path A: multimodal returns PNG attachment, no ask", async () => {
    const worktree = await freshWorktree()
    let asked = false
    const tool = createRenderSvgTool(resolveOptions({}), {
      getModel: () => MULTIMODAL,
      openFile: async () => {},
      nextCallSuffix: () => `a${(suffix += 1)}`,
    })
    const ctx = makeCtx({
      worktree,
      ask: async () => {
        asked = true
      },
    })
    const result = (await tool.execute({ svg: VALID }, ctx)) as {
      output: string
      attachments: { mime: string; url: string }[]
    }
    expect(asked).toBe(false)
    expect(result.attachments.length).toBe(1)
    expect(result.attachments[0].mime).toBe("image/png")
    expect(result.attachments[0].url.startsWith("data:image/png;base64,")).toBe(true)
    expect(result.output).toMatch(/continue iterating/i)
  })

  test("Path B approved: writes cache, opens viewer, returns summary", async () => {
    const worktree = await freshWorktree()
    let askedWith: unknown
    let opened: string[] = []
    const tool = createRenderSvgTool(resolveOptions({}), {
      getModel: () => undefined,
      openFile: async (p) => {
        opened.push(p)
      },
      nextCallSuffix: () => `b${(suffix += 1)}`,
    })
    const ctx = makeCtx({
      worktree,
      sessionID: "ses-b",
      ask: async (input) => {
        askedWith = input
      },
    })
    const result = (await tool.execute({ svg: VALID, title: "Test" }, ctx)) as {
      title: string
      output: string
      metadata: Record<string, unknown>
    }
    expect(opened.length).toBe(1)
    const asked = askedWith as {
      permission: string
      patterns: string[]
      always: string[]
      metadata: Record<string, unknown>
    }
    expect(asked.permission).toBe("render_svg")
    expect(asked.patterns).toEqual(opened)
    expect(asked.always).toEqual(["*"])
    expect(typeof asked.metadata["preview"]).toBe("string")
    expect(String(asked.metadata["preview"]).startsWith("data:image/png;base64,")).toBe(true)
    expect(result.output).toMatch(/approved/)
    expect(result.output).toContain(String(result.metadata["cachePath"]))
    // Cache files exist on disk.
    expect((await stat(String(result.metadata["cachePath"]))).isFile()).toBe(true)
    const pngPath = String(asked.metadata["cachePath"])
    expect((await stat(pngPath)).isFile()).toBe(true)
    const svgBack = await readFile(String(result.metadata["cachePath"]), "utf8")
    expect(svgBack).toBe(VALID)
  })

  test("Path B rejected with feedback propagates message verbatim", async () => {
    const worktree = await freshWorktree()
    const feedback = "make the circle bigger"
    const tool = createRenderSvgTool(resolveOptions({}), {
      getModel: () => TEXT_ONLY,
      openFile: async () => {},
      nextCallSuffix: () => `c${(suffix += 1)}`,
    })
    const ctx = makeCtx({
      worktree,
      sessionID: "ses-c",
      ask: async () => {
        throw new Error(
          `The user rejected permission to use this specific tool call with the following feedback: ${feedback}`,
        )
      },
    })
    const err = await tool.execute({ svg: VALID }, ctx).catch((e: unknown) => e)
    expect((err as Error).message).toContain(feedback)
  })

  test("forceHumanReview routes multimodal models to Path B", async () => {
    const worktree = await freshWorktree()
    let asked = false
    const tool = createRenderSvgTool(resolveOptions({ forceHumanReview: true }), {
      getModel: () => MULTIMODAL,
      openFile: async () => {},
      nextCallSuffix: () => `d${(suffix += 1)}`,
    })
    const ctx = makeCtx({
      worktree,
      sessionID: "ses-d",
      ask: async () => {
        asked = true
      },
    })
    const result = (await tool.execute({ svg: VALID }, ctx)) as { output: string }
    expect(asked).toBe(true)
    expect(result.output).toMatch(/approved/)
  })

  test("autoOpenViewer=false skips open but still asks", async () => {
    const worktree = await freshWorktree()
    let opened = 0
    let asked = false
    const tool = createRenderSvgTool(resolveOptions({ autoOpenViewer: false }), {
      getModel: () => undefined,
      openFile: async () => {
        opened += 1
      },
      nextCallSuffix: () => `e${(suffix += 1)}`,
    })
    const ctx = makeCtx({
      worktree,
      sessionID: "ses-e",
      ask: async () => {
        asked = true
      },
    })
    await tool.execute({ svg: VALID }, ctx)
    expect(opened).toBe(0)
    expect(asked).toBe(true)
  })

  test("open() failure is swallowed, ask still proceeds", async () => {
    const worktree = await freshWorktree()
    let asked = false
    const tool = createRenderSvgTool(resolveOptions({}), {
      getModel: () => undefined,
      openFile: async () => {
        throw new Error("no viewer")
      },
      nextCallSuffix: () => `f${(suffix += 1)}`,
    })
    const ctx = makeCtx({
      worktree,
      sessionID: "ses-f",
      ask: async () => {
        asked = true
      },
    })
    const result = (await tool.execute({ svg: VALID }, ctx)) as { output: string }
    expect(asked).toBe(true)
    expect(result.output).toMatch(/approved/)
  })

  test("invalid SVG throws before rasterize/ask/open", async () => {
    const worktree = await freshWorktree()
    let asked = false
    let opened = 0
    const tool = createRenderSvgTool(resolveOptions({}), {
      getModel: () => MULTIMODAL,
      openFile: async () => {
        opened += 1
      },
      nextCallSuffix: () => `g${(suffix += 1)}`,
    })
    const ctx = makeCtx({
      worktree,
      ask: async () => {
        asked = true
      },
    })
    await expect(
      tool.execute(
        { svg: '<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>' },
        ctx,
      ),
    ).rejects.toThrow(/script/i)
    expect(asked).toBe(false)
    expect(opened).toBe(0)
  })
})
