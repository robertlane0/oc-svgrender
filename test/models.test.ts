import { describe, expect, test } from "bun:test"
import { ModelCapabilities } from "../src/models.ts"

const IMAGE = { providerID: "opencode", id: "vision", capabilities: { input: ["text", "image"] } }
const TEXT = { providerID: "opencode", id: "plain", capabilities: { input: ["text"] } }
const UNDECLARED = { providerID: "custom", id: "mystery" }

function makeCapabilities(models: readonly unknown[] = [IMAGE, TEXT, UNDECLARED]) {
  let calls = 0
  let now = 1_000
  const capabilities = new ModelCapabilities({
    list: async () => {
      calls += 1
      return models as never
    },
    now: () => now,
  })
  return {
    capabilities,
    calls: () => calls,
    advance: (ms: number) => {
      now += ms
    },
  }
}

const primary = (sessionID: string, model: { providerID: string; id: string }) => ({
  sessionID,
  kind: "primary" as const,
  model,
})

describe("ModelCapabilities", () => {
  test("an unknown session is text-only, not multimodal", async () => {
    const { capabilities, calls } = makeCapabilities()
    expect(await capabilities.acceptsImage("ses-missing")).toBe(false)
    expect(calls()).toBe(0)
  })

  test("tracks the primary request model per session", async () => {
    const { capabilities, calls } = makeCapabilities()
    capabilities.track(primary("ses-1", { providerID: "opencode", id: "vision" }))
    expect(await capabilities.acceptsImage("ses-1")).toBe(true)
    expect(calls()).toBe(1)
  })

  test("a text-only model resolves false", async () => {
    const { capabilities } = makeCapabilities()
    capabilities.track(primary("ses-2", { providerID: "opencode", id: "plain" }))
    expect(await capabilities.acceptsImage("ses-2")).toBe(false)
  })

  test("a model without declared capabilities resolves false", async () => {
    const { capabilities } = makeCapabilities()
    capabilities.track(primary("ses-3", { providerID: "custom", id: "mystery" }))
    expect(await capabilities.acceptsImage("ses-3")).toBe(false)
  })

  test("a model switch overwrites the session entry", async () => {
    const { capabilities } = makeCapabilities()
    capabilities.track(primary("ses-4", { providerID: "opencode", id: "plain" }))
    capabilities.track(primary("ses-4", { providerID: "opencode", id: "vision" }))
    expect(await capabilities.acceptsImage("ses-4")).toBe(true)
  })

  test("non-primary requests never overwrite the model", async () => {
    const { capabilities } = makeCapabilities()
    capabilities.track(primary("ses-5", { providerID: "opencode", id: "vision" }))
    capabilities.track({
      sessionID: "ses-5",
      kind: "title",
      model: { providerID: "opencode", id: "plain" },
    })
    expect(await capabilities.acceptsImage("ses-5")).toBe(true)
  })

  test("the catalog is fetched once per window and cached per model", async () => {
    const { capabilities, calls, advance } = makeCapabilities([
      IMAGE,
      TEXT,
      { providerID: "opencode", id: "vision-2", capabilities: { input: ["text", "image"] } },
    ])
    capabilities.track(primary("ses-6", { providerID: "opencode", id: "vision" }))
    capabilities.track(primary("ses-7", { providerID: "opencode", id: "plain" }))
    expect(await capabilities.acceptsImage("ses-6")).toBe(true)
    expect(await capabilities.acceptsImage("ses-7")).toBe(false)
    expect(await capabilities.acceptsImage("ses-6")).toBe(true)
    expect(calls()).toBe(1)
    // A model the cache has never seen forces a catalog walk, at most one per window.
    capabilities.track(primary("ses-8", { providerID: "opencode", id: "vision-2" }))
    expect(await capabilities.acceptsImage("ses-8")).toBe(true)
    expect(calls()).toBe(1)
    advance(60_001)
    capabilities.track(primary("ses-9", { providerID: "opencode", id: "late" }))
    expect(await capabilities.acceptsImage("ses-9")).toBe(false)
    expect(calls()).toBe(2)
  })

  test("a failing catalog degrades to text-only instead of throwing", async () => {
    const capabilities = new ModelCapabilities({
      list: async () => {
        throw new Error("no models")
      },
    })
    capabilities.track(primary("ses-9", { providerID: "opencode", id: "vision" }))
    expect(await capabilities.acceptsImage("ses-9")).toBe(false)
  })

  test("a cold catalog that never answers falls back to text-only inside the budget", async () => {
    const capabilities = new ModelCapabilities({
      list: () => new Promise<readonly never[]>(() => {}),
      budgetMs: 25,
    })
    capabilities.track(primary("ses-10", { providerID: "opencode", id: "vision" }))
    const started = Date.now()
    expect(await capabilities.acceptsImage("ses-10")).toBe(false)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test("prefetch warms the catalog before the first render", async () => {
    const { capabilities, calls } = makeCapabilities()
    capabilities.track(primary("ses-11", { providerID: "opencode", id: "vision" }))
    await capabilities.prefetch()
    expect(calls()).toBe(1)
    expect(await capabilities.acceptsImage("ses-11")).toBe(true)
    expect(calls()).toBe(1)
  })

  test("the session cache is bounded and clearable", async () => {
    const { capabilities } = makeCapabilities()
    for (let i = 0; i < 250; i++)
      capabilities.track(primary(`s${i}`, { providerID: "opencode", id: i < 100 ? "vision" : "plain" }))
    // Only the newest 200 sessions survive, so the first 50 are unknown.
    expect(await capabilities.acceptsImage("s0")).toBe(false)
    expect(await capabilities.acceptsImage("s60")).toBe(true)
    expect(await capabilities.acceptsImage("s249")).toBe(false)
    capabilities.clear()
    expect(await capabilities.acceptsImage("s60")).toBe(false)
  })
})
