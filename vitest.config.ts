import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.toml" }
    })
  ],
  test: {
    // Vitest 5 defaults this on; workerd cannot read node_modules/.vitest-cache.
    fsModuleCache: false
  }
});
