/**
 * Plugin entry: render-svg.
 *
 * OpenCode v2 shape: a plugin is `{ id, setup(ctx) }`. Tools are contributed
 * imperatively from `setup` through `ctx.tool.transform`, options arrive as
 * `ctx.options`, and the working directory is `ctx.location.directory`.
 *
 * `session.hook("model.request")` feeds the session→model cache that decides
 * between the multimodal and human routes; see `models.ts`.
 */
import type { Plugin } from "@opencode/plugin"
import { resolveOptions } from "./config.ts"
import type { RenderSvgOptions } from "./config.ts"
import { attachModelCapabilities } from "./models.ts"
import { createRenderSvgTool } from "./render_svg.ts"

export const ID = "render-svg"

export const RenderSvgPlugin = {
  id: ID,
  async setup(ctx: Plugin.Context) {
    const options = resolveOptions(ctx.options as RenderSvgOptions | undefined)
    const directory = ctx.location.directory
    const { capabilities, dispose: disposeModels } = await attachModelCapabilities(ctx)
    // Warm the model catalog here, where latency is free: the first render of a
    // session must not wait on a cold `ctx.model.list()`.
    void capabilities.prefetch()
    const registration = await ctx.tool.transform((editor) => {
      editor.add(
        createRenderSvgTool({
          options,
          directory,
          acceptsImage: (sessionID) => capabilities.acceptsImage(sessionID),
        }),
      )
    })
    return async () => {
      capabilities.clear()
      await disposeModels()
      await registration.dispose()
    }
  },
} satisfies Plugin.Plugin

export default RenderSvgPlugin
