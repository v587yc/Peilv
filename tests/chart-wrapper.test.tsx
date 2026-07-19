// @vitest-environment happy-dom

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="responsive-container">{children}</div>
  ),
  Tooltip: "tooltip",
  Legend: "legend",
}))

import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { ChartContainer, ChartLegendContent, ChartTooltipContent } from "@/components/ui/chart"

let host: HTMLDivElement
let root: Root

function render(element: React.ReactElement) {
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(element))
  return host
}

describe("chart wrapper", () => {
  const originalConsoleError = console.error
  const originalConsoleWarn = console.warn

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
  })

  afterEach(() => {
    root?.unmount()
    host?.remove()
    vi.restoreAllMocks()
  })

  afterAll(() => {
    console.error = originalConsoleError
    console.warn = originalConsoleWarn
  })

  it("renders ChartContainer and its responsive child without React 19 warnings", async () => {
    const container = render(
      <ChartContainer id="sales" config={{ sales: { label: "Sales", color: "#22c55e" } }}>
        <div data-testid="chart-child">chart</div>
      </ChartContainer>,
    )

    await new Promise<void>((resolve) => queueMicrotask(() => resolve()))

    expect(container.querySelector('[data-slot="chart"]')?.getAttribute("data-chart")).toBe(
      "chart-sales",
    )
    expect(container.querySelector("[data-testid=responsive-container]")).toBeTruthy()
    expect(container.querySelector("[data-testid=chart-child]")?.textContent).toBe("chart")
    expect(console.error).not.toHaveBeenCalled()
    expect(console.warn).not.toHaveBeenCalled()
  })

  it("renders custom tooltip content, config labels, and payload colors", async () => {
    const container = render(
      <ChartContainer config={{ sales: { label: "Sales", color: "#22c55e" } }}>
        <ChartTooltipContent
          active
          label="sales"
          payload={[
            {
              dataKey: "sales",
              name: "sales",
              value: 1234,
              color: "#ef4444",
              payload: { fill: "#3b82f6" },
            },
          ]}
        />
      </ChartContainer>,
    )

    await new Promise<void>((resolve) => queueMicrotask(() => resolve()))

    expect(container.textContent).toContain("Sales")
    expect(container.textContent).toContain("1,234")
    expect(container.querySelector('[style*="--color-bg"]')).toBeTruthy()
    expect(container.querySelector('[style*="--color-bg"]')?.getAttribute("style")).toContain(
      "#3b82f6",
    )
  })

  it("renders a zero tooltip value instead of treating it as empty", async () => {
    const container = render(
      <ChartContainer config={{ sales: { label: "Sales", color: "#22c55e" } }}>
        <ChartTooltipContent
          active
          label="sales"
          payload={[{ dataKey: "sales", name: "sales", value: 0, color: "#22c55e" }]}
        />
      </ChartContainer>,
    )

    await new Promise<void>((resolve) => queueMicrotask(() => resolve()))

    expect(container.textContent).toContain("0")
  })

  it("renders custom legend content and filters empty payloads", async () => {
    const container = render(
      <ChartContainer config={{ sales: { label: "Sales", color: "#22c55e" } }}>
        <>
          <ChartLegendContent
            verticalAlign="bottom"
            payload={[{ dataKey: "sales", value: "Sales", color: "#22c55e" }]}
          />
          <ChartTooltipContent active payload={[]} />
          <ChartLegendContent verticalAlign="bottom" payload={[]} />
        </>
      </ChartContainer>,
    )

    await new Promise<void>((resolve) => queueMicrotask(() => resolve()))

    expect(container.textContent).toContain("Sales")
    expect(container.querySelectorAll("[data-testid=responsive-container] > div").length).toBe(1)
    expect(container.querySelectorAll(".bg-background").length).toBe(0)
    expect(container.querySelectorAll("[style*=" + "background-color" + "]").length).toBe(1)
  })
})
