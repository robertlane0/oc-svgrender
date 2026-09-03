import { describe, expect, test } from "bun:test"
import { summarizeSvg } from "../src/summarize.ts"

describe("summarizeSvg", () => {
  test("counts elements and extracts viewBox", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600">' +
      '<rect width="10" height="10"/><rect width="5" height="5"/><rect width="1" height="1"/>' +
      '<path d="M0 0h1"/><path d="M0 0h2"/><circle r="5"/></svg>'
    const s = summarizeSvg(svg)
    expect(s).toContain("3 <rect>")
    expect(s).toContain("2 <path>")
    expect(s).toContain("1 <circle>")
    expect(s).toContain("viewBox 0 0 800 600")
    expect(s.length).toBeLessThanOrEqual(300)
  })

  test("falls back to width/height and byte count", () => {
    const s = summarizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><line x1="0" y1="0" x2="1" y2="1"/></svg>',
    )
    expect(s).toContain("1 <line>")
    expect(s).toContain("100x50")
    expect(s).toMatch(/\d+ bytes/)
  })

  test("empty svg summary", () => {
    const s = summarizeSvg('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    expect(s).toContain("empty svg")
  })
})
