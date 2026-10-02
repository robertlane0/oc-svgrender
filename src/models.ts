/**
 * Model-capability cache: which sessions are driving an image-capable model.
 *
 * V1 read the active model from the `chat.params` hook. V2 has no such hook;
 * the promise plugin API exposes `session.hook("model.request")`, which fires
 * immediately before every provider dispatch and carries the resolved
 * `Model.Ref`. That is the v2 equivalent and the reason a tool can still know
 * whether the model on the other end can look at a PNG.
 *
 * Only `kind === "primary"` requests are recorded: compaction/title/generate
 * requests run cheaper models that never answer a `render_svg` call, and
 * letting them overwrite the entry would misroute the next render.
 *
 * A miss is not an error, it is the safe default: text-only treatment.
 */
import type { Plugin } from "@opencode/plugin"

const MAX_SESSIONS = 200
/** Models change rarely; a minute of staleness beats a catalog walk per render. */
const REFRESH_MS = 60_000
/**
 * A cold `ctx.model.list()` can block for a long time — the catalog comes from
 * a network fetch that may be slow or timing out. A render must not wait on
 * that: the tool result is what the model is blocked on, and OpenCode marks a
 * still-running tool as "result missing" and moves on. Past this budget the
 * render takes the text-only route, which is always a valid answer.
 */
const LOOKUP_BUDGET_MS = 2_000

export type ModelRef = { providerID: string; id: string }

type ModelInfo = { providerID: string; id: string; capabilities?: { input?: readonly string[] } }

type ModelRequestEvent = {
  sessionID: string
  kind: string
  model: ModelRef
}

export type ModelCapabilitiesDeps = {
  /** `ctx.model.list()` from the plugin context. */
  list: () => Promise<readonly ModelInfo[]>
  now?: () => number
  /** Budget for one catalog walk; see LOOKUP_BUDGET_MS. */
  budgetMs?: number
}

export class ModelCapabilities {
  private readonly sessions = new Map<string, ModelRef>()
  private readonly imageInput = new Map<string, boolean>()
  private readonly deps: ModelCapabilitiesDeps
  private readonly now: () => number
  private readonly budget: number
  private fetched = 0
  private pending: Promise<void> | undefined

  constructor(deps: ModelCapabilitiesDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.budget = deps.budgetMs ?? LOOKUP_BUDGET_MS
  }

  /** Record the model a session is about to dispatch to. */
  track(event: ModelRequestEvent): void {
    if (event.kind !== "primary") return
    this.sessions.delete(event.sessionID)
    this.sessions.set(event.sessionID, { providerID: event.model.providerID, id: event.model.id })
    while (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next()
      if (oldest.done === true) break
      this.sessions.delete(oldest.value)
    }
  }

  /** True when the session's model declares `image` input. Unknown ⇒ false. */
  async acceptsImage(sessionID: string): Promise<boolean> {
    const ref = this.sessions.get(sessionID)
    if (!ref) return false
    const key = `${ref.providerID}/${ref.id}`
    const cached = this.imageInput.get(key)
    if (cached !== undefined) return cached
    // Only an unresolved model pays for a catalog walk, and only for the
    // duration of one budget window.
    if (!(await within(this.refresh(), this.budget))) return false
    return this.imageInput.get(key) ?? false
  }

  /** Warm the catalog outside a tool call, where latency costs nothing. */
  async prefetch(): Promise<void> {
    await this.refresh()
  }

  clear(): void {
    this.sessions.clear()
    this.imageInput.clear()
    this.pending = undefined
    this.fetched = 0
  }

  private async refresh(): Promise<void> {
    const pending = this.pending
    if (pending) return pending
    if (this.fetched > 0 && this.now() - this.fetched < REFRESH_MS) return
    const walk = (async () => {
      try {
        const models = await this.deps.list()
        for (const model of models) {
          this.imageInput.set(
            `${model.providerID}/${model.id}`,
            model.capabilities?.input?.includes("image") === true,
          )
        }
        this.fetched = this.now()
      } catch {
        // A missing catalog is not fatal: an unresolved model stays text-only.
      }
    })().finally(() => {
      if (this.pending === walk) this.pending = undefined
    })
    this.pending = walk
    return walk
  }
}

/** Resolves false when `work` outlives the budget; never rejects. */
async function within(work: Promise<void>, budget: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), budget)
  })
  try {
    return await Promise.race([work.then(() => true as const), expiry])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Build the cache and subscribe it to `model.request`. The returned disposer is
 * also invoked by the plugin scope, but the plugin hands it back from `setup`
 * so a hot reload leaves nothing behind.
 */
export async function attachModelCapabilities(ctx: Plugin.Context): Promise<{
  capabilities: ModelCapabilities
  dispose: () => Promise<void>
}> {
  const capabilities = new ModelCapabilities({
    list: async () =>
      (await ctx.model.list()).data.map((model) => ({
        providerID: model.providerID,
        id: model.id,
        capabilities: model.capabilities,
      })),
  })
  const registration = await ctx.session.hook("model.request", (event) => {
    capabilities.track({
      sessionID: event.sessionID,
      kind: event.kind,
      model: event.model,
    })
  })
  return { capabilities, dispose: () => registration.dispose() }
}
