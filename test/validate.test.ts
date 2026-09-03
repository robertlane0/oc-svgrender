import { describe, expect, test } from "bun:test"
import { validateSvg, ValidateError } from "../src/validate.ts"

const OPTS = { maxSvgBytes: 256_000, maxPixels: 4_000_000 }

const VALID =
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>'

describe("validateSvg", () => {
  test("accepts minimal valid SVG unchanged", () => {
    expect(validateSvg(VALID, OPTS)).toBe(VALID)
  })

  test("rejects empty input", () => {
    expect(() => validateSvg("  ", OPTS)).toThrow(ValidateError)
  })

  test("rejects missing <svg> root", () => {
    expect(() => validateSvg("<div><p>hi</p></div>", OPTS)).toThrow(/<svg>/)
  })

  test("rejects wrong root element", () => {
    expect(() => validateSvg('<html><body><svg/></body></html>', OPTS)).toThrow(/<svg>/)
  })

  test("rejects malformed XML", () => {
    expect(() =>
      validateSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect></svg>', OPTS),
    ).toThrow(/parse error/i)
  })

  test("rejects <script>", () => {
    expect(() =>
      validateSvg(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        OPTS,
      ),
    ).toThrow(/script/i)
  })

  test("rejects case-variant <ScRiPt>", () => {
    expect(() =>
      validateSvg('<svg xmlns="http://www.w3.org/2000/svg"><ScRiPt>x</sCrIpT></svg>', OPTS),
    ).toThrow(/script/i)
  })

  test("rejects on* event attributes", () => {
    expect(() =>
      validateSvg(
        '<svg xmlns="http://www.w3.org/2000/svg" onload="evil()"><rect width="10" height="10"/></svg>',
        OPTS,
      ),
    ).toThrow(/on\*|event-handler/i)
  })

  test("rejects <foreignObject>", () => {
    expect(() =>
      validateSvg(
        '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><body xmlns="http://www.w3.org/1999/xhtml">x</body></foreignObject></svg>',
        OPTS,
      ),
    ).toThrow(/foreignObject/i)
  })

  test("rejects external href", () => {
    expect(() =>
      validateSvg(
        '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/x.png" width="10" height="10"/></svg>',
        OPTS,
      ),
    ).toThrow(/self-contained/i)
  })

  test("rejects protocol-relative href", () => {
    expect(() =>
      validateSvg(
        '<svg xmlns="http://www.w3.org/2000/svg"><use href="//example.com/s.svg#x"/></svg>',
        OPTS,
      ),
    ).toThrow(/self-contained/i)
  })

  test("rejects external url() fill", () => {
    expect(() =>
      validateSvg(
        '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" fill="url(http://example.com/g)"/></svg>',
        OPTS,
      ),
    ).toThrow(/url\(\)/i)
  })

  test("rejects @import", () => {
    expect(() =>
      validateSvg(
        '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "http://example.com/x.css";</style></svg>',
        OPTS,
      ),
    ).toThrow(/@import/i)
  })

  test("allows fragment url() and data:image href", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"></linearGradient></defs>' +
      '<rect width="10" height="10" fill="url(#g)"/></svg>'
    expect(validateSvg(svg, OPTS)).toBe(svg)
  })

  test("rejects oversize markup", () => {
    const big = "<svg>" + " ".repeat(101) + "</svg>"
    expect(() => validateSvg(big, { ...OPTS, maxSvgBytes: 100 })).toThrow(/byte limit/)
    expect(() => validateSvg(big, { ...OPTS, maxSvgBytes: 100 })).toThrow(ValidateError)
  })

  test("rejects pixel area over maxPixels", () => {
    expect(() =>
      validateSvg(VALID, { ...OPTS, maxPixels: 100, width: 100, height: 100 }),
    ).toThrow(/px limit/)
  })

  test("rejects excessive nesting depth", () => {
    let svg = '<svg xmlns="http://www.w3.org/2000/svg">'
    for (let i = 0; i < 140; i++) svg += "<g>"
    for (let i = 0; i < 140; i++) svg += "</g>"
    svg += "</svg>"
    expect(() => validateSvg(svg, OPTS)).toThrow(/nesting depth/i)
  })

  test("rejects <use> bomb", () => {
    let svg = '<svg xmlns="http://www.w3.org/2000/svg">'
    for (let i = 0; i < 501; i++) svg += '<use href="#x"/>'
    svg += "</svg>"
    expect(() => validateSvg(svg, OPTS)).toThrow(/<use>\/<pattern>/)
  })
})
