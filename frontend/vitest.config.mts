import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Vite's native resolve.tsconfigPaths reads the same tsconfig.json as the
// app, so `@/*` resolves from one place instead of being duplicated here.
// (Previously the vite-tsconfig-paths plugin; Vite 8 absorbed this natively.)
export default defineConfig({
  plugins: [react()],
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.mts"],
    globals: false,
    css: false,
  },
});
