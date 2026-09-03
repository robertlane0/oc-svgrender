import { describe, expect, test } from "bun:test"
import { clearModelCache, modelBySession, RenderSvgPlugin, trackModel } from "../src/index.ts"

describe("plugin entry", () => {
  test("chat.params hook caches model per session", async () => {
    clearModelCache()
    const hooks = await RenderSvgPlugin(
      // @ts-expect-error - minimal PluginInput stub
      {},
      {},
    )
    const params = hooks["chat.params"]
    if (!params) throw new Error("missing chat.params hook")
    await params(
      // @ts-expect-error - minimal hook input stub
      { sessionID: "s1", model: { capabilities: { input: { image: true } } } },
      {},
    )
    expect(modelBySession.get("s1")?.capabilities?.input?.image).toBe(true)
    expect(typeof hooks.tool?.["render_svg"]).toBe("object")
    if (hooks.dispose) await hooks.dispose()
    expect(modelBySession.size).toBe(0)
  })

  test("trackModel bounds cache size", () => {
    clearModelCache()
    for (let i = 0; i < 250; i++) {
      trackModel(`s${i}`, { capabilities: { input: { image: false } } })
    }
    expect(modelBySession.size).toBeLessThanOrEqual(200)
    clearModelCache()
  })

  test("default export matches named export", async () => {
    const mod = await import("../src/index.ts")
    expect(mod.default).toBe(RenderSvgPlugin)
  })
})
