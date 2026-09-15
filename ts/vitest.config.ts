import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: { STRATUM_PEER_REGISTER: "0" },
  },
});
