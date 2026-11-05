import { defineConfig, mergeConfig } from "vitest/config"
import viteConfig from "./vite.config.ts"

export default mergeConfig(
  viteConfig({ mode: "test", command: "serve" }),
  defineConfig({
    test: {
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      include: ["src/**/*.test.{ts,tsx}"],
      restoreMocks: true,
      testTimeout: 30_000,
      coverage: {
        provider: "v8",
        include: ["src/**/*.{ts,tsx}"],
        exclude: ["src/test/**", "src/**/*.test.{ts,tsx}", "src/components/ui/**", "src/main.tsx", "src/vite-env.d.ts"],
        reporter: ["text", "lcov"],
        thresholds: { lines: 100, functions: 100, statements: 100, branches: 100 },
      },
    },
  }),
)
