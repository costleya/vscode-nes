import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import * as vscode from "vscode";

import { ApiClient } from "~/api/client.ts";
import { ZETA2_1_EOS_MARKER } from "~/api/zeta2-prompt.ts";
import type { CompletionServer } from "~/services/completion-server.ts";

function setConfiguration(values: Record<string, unknown>): void {
  (
    globalThis as typeof globalThis & {
      __vscodeMockConfiguration?: Record<string, unknown>;
    }
  ).__vscodeMockConfiguration = values;
}

afterEach(() => {
  setConfiguration({});
  vi.restoreAllMocks();
});

describe("ApiClient model protocol", () => {
  test.each([undefined, "local-model-alias", "sweepai/sweep-next-edit"])(
    "dispatches Zeta 2.1 prompts and parses marker edits for model %j",
    async (modelName) => {
      setConfiguration({ modelName, maxContextFiles: 0, outlineSymbols: 0 });
      const text = "before\nold();\nafter\n";
      const lines = text.split("\n");
      const offsetAt = (position: vscode.Position) =>
        lines.slice(0, position.line).reduce((length, line) => length + line.length + 1, 0) +
        position.character;
      const document = {
        uri: vscode.Uri.file("/workspace/example.ts"),
        languageId: "typescript",
        lineCount: lines.length,
        getText: (range?: vscode.Range) =>
          range ? text.slice(offsetAt(range.start), offsetAt(range.end)) : text,
        lineAt: (line: number) => ({ text: lines[line] ?? "" }),
        offsetAt,
      } as unknown as vscode.TextDocument;
      const complete = vi.fn().mockResolvedValue({
        text: `<|marker_1|>\nbefore\nnew();\nafter\n<|marker_2|>${ZETA2_1_EOS_MARKER}`,
        finishReason: "stop",
      });
      const server = {
        getClient: () => ({ complete }),
        reportSuccess: vi.fn(),
        reportFailure: vi.fn(),
      };
      const client = new ApiClient(server as unknown as CompletionServer);
      vi.spyOn(client, "getDebugInfo").mockReturnValue("test");

      const result = await client.getAutocomplete({
        document,
        position: new vscode.Position(1, 0),
        originalContent: text,
        recentChanges: [],
        recentBuffers: [],
        diagnostics: [],
        userActions: [],
      });

      expect(complete).toHaveBeenCalledOnce();
      expect(complete).toHaveBeenCalledWith(
        expect.objectContaining({
          model: modelName ?? "zeta-2.1",
          stop: [ZETA2_1_EOS_MARKER],
          prompt: expect.stringContaining("<|marker_1|>\nbefore\n<|user_cursor|>old();"),
        }),
        undefined,
      );
      expect(result).toEqual([
        expect.objectContaining({
          startIndex: "before\n".length,
          endIndex: "before\nold();".length,
          completion: "new();",
        }),
      ]);
      expect(server.reportSuccess).toHaveBeenCalledOnce();
      expect(server.reportFailure).not.toHaveBeenCalled();
    },
  );
});
