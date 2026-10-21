import { afterEach, describe, expect, test } from "vite-plus/test";

import { config } from "~/core/config.ts";

function setConfiguration(values: Record<string, unknown>): void {
  (
    globalThis as typeof globalThis & {
      __vscodeMockConfiguration?: Record<string, unknown>;
    }
  ).__vscodeMockConfiguration = values;
}

afterEach(() => setConfiguration({}));

describe("model settings", () => {
  test("defaults to Zeta 2.1 and its 350-token editable budget", () => {
    setConfiguration({});

    expect(config.modelName).toBe("zeta-2.1");
    expect(config.editableTokens).toBe(350);
  });

  test("preserves configured server aliases and editable budget overrides", () => {
    setConfiguration({ modelName: "local-model-alias", editableTokens: 900 });

    expect(config.modelName).toBe("local-model-alias");
    expect(config.editableTokens).toBe(900);
  });
});
