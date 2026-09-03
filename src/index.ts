/**
 * Plugin entry: RenderSvgPlugin.
 *
 * Bridges `chat.params` (which sees the active Model) to the tool's
 * `execute` (whose ToolContext does not) via a bounded session→model cache.
 * Missing cache entries fall back to the human-review path (safe default).
 */
import type { Plugin } from "@opencode-ai/plugin"
import { resolveOptions } from "./config.ts"
import type { RenderSvgOptions } from "./config.ts"
import { createRenderSvgTool } from "./render_svg.ts"
import type { ModelLike } from "./render_svg.ts"

const MAX_SESSIONS = 200

export const modelBySession = new Map<string, ModelLike>()

export function trackModel(sessionID: string, model: ModelLike): void {
  if (modelBySession.has(sessionID)) {
    modelBySession.delete(sessionID)
  }
  modelBySession.set(sessionID, model)
  while (modelBySession.size > MAX_SESSIONS) {
    const oldest = modelBySession.keys().next()
    if (oldest.done === true) break
    modelBySession.delete(oldest.value)
  }
}

export function clearModelCache(): void {
  modelBySession.clear()
}

export const RenderSvgPlugin: Plugin = async (_input, rawOptions) => {
  const options = resolveOptions(rawOptions as RenderSvgOptions | undefined)
  const renderSvg = createRenderSvgTool(options, {
    getModel: (sessionID) => modelBySession.get(sessionID),
  })
  return {
    "chat.params": async (input) => {
      trackModel(input.sessionID, input.model as unknown as ModelLike)
    },
    tool: {
      render_svg: renderSvg,
    },
    dispose: async () => {
      clearModelCache()
    },
  }
}

export default RenderSvgPlugin
