import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import * as vscode from "vscode";

import {
  enableForwardStability,
  INLINE_COMPLETION_DISPLAY_LOCATION_KIND,
  markAsProposedInlineEdit,
  registerInlineCompletionItemProviderWithMetadata,
} from "~/editor/proposed-inline-edit.ts";

describe("inline completion provider registration", () => {
  const selector: vscode.DocumentSelector = [{ scheme: "file", language: "typescript" }];
  const provider: vscode.InlineCompletionItemProvider = {
    provideInlineCompletionItems: () => [],
  };
  const metadata = {
    groupId: "nesweep",
    debounceDelayMs: 0,
    displayName: "NESweep",
    excludes: ["other-provider"],
    yieldTo: ["preferred-provider"],
  };
  const proposalDenial = new Error(
    "Extension 'sr-team.nesweep' CANNOT use API proposal: inlineCompletionsAdditions.\n" +
      "Its package.json#enabledApiProposals-property declares: [] but NOT inlineCompletionsAdditions.\n" +
      " The missing proposal MUST be added and you must start in extension development mode or use the following command line switch: --enable-proposed-api sr-team.nesweep",
  );

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("preserves provider metadata and the returned disposable when proposed APIs are enabled", () => {
    const disposable = { dispose: vi.fn() };
    const register = vi
      .spyOn(vscode.languages, "registerInlineCompletionItemProvider")
      .mockReturnValue(disposable);

    const result = registerInlineCompletionItemProviderWithMetadata(selector, provider, metadata);

    expect(register.mock.calls).toEqual([[selector, provider, metadata]]);
    expect(register.mock.calls[0]?.[0]).toBe(selector);
    expect(register.mock.calls[0]?.[1]).toBe(provider);
    expect((register.mock.calls[0] as unknown[])[2]).toBe(metadata);
    expect(result).toBe(disposable);
    expect(disposable.dispose).not.toHaveBeenCalled();
  });

  test("retries with exactly the stable API arguments when VS Code denies the metadata proposal", () => {
    const disposable = { dispose: vi.fn() };
    const register = vi
      .spyOn(vscode.languages, "registerInlineCompletionItemProvider")
      .mockImplementationOnce(() => {
        throw proposalDenial;
      })
      .mockReturnValueOnce(disposable);

    const result = registerInlineCompletionItemProviderWithMetadata(selector, provider, metadata);

    expect(register.mock.calls).toEqual([
      [selector, provider, metadata],
      [selector, provider],
    ]);
    expect(register.mock.calls[1]?.[0]).toBe(selector);
    expect(register.mock.calls[1]?.[1]).toBe(provider);
    expect(result).toBe(disposable);
    expect(disposable.dispose).not.toHaveBeenCalled();
  });

  test.each([
    {
      label: "an unrelated registration error",
      failure: new Error("Provider registration failed"),
    },
    {
      label: "a different API proposal denial",
      failure: new Error("Extension 'sr-team.nesweep' CANNOT use API proposal: inlineEdit."),
    },
    {
      label: "an error mentioning the proposal without denying access",
      failure: new TypeError("Invalid inlineCompletionsAdditions metadata"),
    },
    { label: "a thrown string", failure: "registration failed" },
    { label: "a thrown object", failure: { message: proposalDenial.message } },
  ])("propagates $label without retrying", ({ failure }) => {
    const register = vi
      .spyOn(vscode.languages, "registerInlineCompletionItemProvider")
      .mockImplementation(() => {
        throw failure;
      });
    let thrown: unknown;

    try {
      registerInlineCompletionItemProviderWithMetadata(selector, provider, metadata);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(failure);
    expect(register.mock.calls).toEqual([[selector, provider, metadata]]);
  });

  test("propagates a stable registration failure after the proposal denial", () => {
    const fallbackFailure = new Error("Stable registration failed");
    const register = vi
      .spyOn(vscode.languages, "registerInlineCompletionItemProvider")
      .mockImplementationOnce(() => {
        throw proposalDenial;
      })
      .mockImplementationOnce(() => {
        throw fallbackFailure;
      });
    let thrown: unknown;

    try {
      registerInlineCompletionItemProviderWithMetadata(selector, provider, metadata);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(fallbackFailure);
    expect(register.mock.calls).toEqual([
      [selector, provider, metadata],
      [selector, provider],
    ]);
  });
});

describe("proposed inline edit presentation", () => {
  test("marks an item as a VS Code inline edit with a menu and display location", () => {
    const editRange = new vscode.Range(new vscode.Position(10, 2), new vscode.Position(10, 8));
    const displayRange = new vscode.Range(new vscode.Position(3, 0), new vscode.Position(3, 0));
    const item = new vscode.InlineCompletionItem("replacement", editRange);

    const proposed = markAsProposedInlineEdit(item, {
      showRange: editRange,
      displayLocation: {
        range: displayRange,
        label: "Edit at line 11",
        kind: INLINE_COMPLETION_DISPLAY_LOCATION_KIND.Label,
      },
      correlationId: "nesweep-test",
    });

    expect(proposed.isInlineEdit).toBe(true);
    expect(proposed.showInlineEditMenu).toBe(true);
    expect(proposed.showRange).toBe(editRange);
    expect(proposed.displayLocation?.range).toBe(displayRange);
    expect(proposed.displayLocation?.label).toBe("Edit at line 11");
    expect(proposed.displayLocation?.kind).toBe(INLINE_COMPLETION_DISPLAY_LOCATION_KIND.Label);
    expect(proposed.correlationId).toBe("nesweep-test");
  });

  test("enables forward stability on returned inline completion lists", () => {
    const list: vscode.InlineCompletionList = { items: [] };

    const proposed = enableForwardStability(list);

    expect(proposed.enableForwardStability).toBe(true);
  });
});
