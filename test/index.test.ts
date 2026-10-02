import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { RenderSvgPlugin, ID } from "../src/index.ts"
import { TOOL_NAME } from "../src/render_svg.ts"

type Hook = (event: unknown) => void | Promise<void>

/** The two plugin domains this plugin touches, stubbed with the rest omitted. */
function makeContext(options: Record<string, unknown> = {}) {
  const hooks: { name: string; callback: Hook }[] = []
  const added: { name: string }[] = []
  let disposedTools = 0
  let disposedHooks = 0
  const ctx = {
    options,
    location: { directory: "/tmp/project" },
    model: { list: async () => ({ data: [] }) },
    session: {
      hook: async (name: string, callback: Hook) => {
        hooks.push({ name, callback })
        return {
          dispose: async () => {
            disposedHooks += 1
          },
        }
      },
    },
    tool: {
      transform: async (callback: (editor: { add: (tool: { name: string }) => void }) => void) => {
        callback({ add: (tool) => added.push(tool) })
        return {
          dispose: async () => {
            disposedTools += 1
          },
        }
      },
    },
  } as unknown as Plugin.Context
  return {
    ctx,
    hooks,
    added,
    counts: () => ({ disposedTools, disposedHooks }),
  }
}

describe("plugin entry", () => {
  test("setup registers the render_svg tool and a model.request hook", async () => {
    const { ctx, hooks, added } = makeContext()
    const cleanup = await RenderSvgPlugin.setup(ctx)
    expect(RenderSvgPlugin.id).toBe(ID)
    expect(added.map((tool) => tool.name)).toEqual([TOOL_NAME])
    expect(hooks.map((hook) => hook.name)).toEqual(["model.request"])
    expect(typeof cleanup).toBe("function")
    if (typeof cleanup === "function") await cleanup()
  })

  test("cleanup disposes the hook and the tool registration", async () => {
    const { ctx, counts } = makeContext()
    const cleanup = await RenderSvgPlugin.setup(ctx)
    if (typeof cleanup !== "function") throw new Error("setup returned no cleanup")
    await cleanup()
    expect(counts()).toEqual({ disposedTools: 1, disposedHooks: 1 })
  })

  test("plugin options are read from ctx.options", async () => {
    const { ctx } = makeContext({ maxPixels: 1234, cacheDir: "/tmp/custom" })
    const cleanup = await RenderSvgPlugin.setup(ctx)
    if (typeof cleanup === "function") await cleanup()
  })

  test("default export matches the named export", async () => {
    const mod = await import("../src/index.ts")
    expect(mod.default).toBe(RenderSvgPlugin)
  })
})
