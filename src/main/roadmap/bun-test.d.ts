// Ambient types for the `bun:test` module. The roadmap store/segmentation
// tests run via `bun test`; the Electron node typecheck program has no
// bun-types package, so this declares the small surface the tests use.

declare module 'bun:test' {
  type BunTestMatchers = {
    toBe(expected: unknown): void
    toBeNull(): void
    toHaveLength(length: number): void
    toBeGreaterThan(expected: number): void
    toBeGreaterThanOrEqual(expected: number): void
    toBeLessThanOrEqual(expected: number): void
  }
  export function describe(name: string, fn: () => void): void
  export function it(name: string, fn: () => void | Promise<void>): void
  export function expect(actual: unknown): BunTestMatchers & { not: BunTestMatchers }
}
