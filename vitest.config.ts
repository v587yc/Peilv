import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    exclude: ["**/node_modules/**", "**/.git/**", "**/.claude/worktrees/**"],
    coverage: {
      provider: "v8",
      include: [
        "src/lib/safe-fetch.ts",
        "src/lib/internal-auth.ts",
        "src/app/api/analysis/route.ts",
        "src/app/api/report/route.ts",
      ],
      reporter: ["text", "json", "html"],
    },
  },
});
