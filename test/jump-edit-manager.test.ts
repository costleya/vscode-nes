import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import * as vscode from "vscode";

import { JumpEditManager } from "~/editor/jump-edit-manager.ts";
import {
  createHighlightedBoxDecoration,
  createHighlightedBoxDecorationMultiline,
} from "~/editor/syntax-highlight-renderer.ts";

vi.mock("~/editor/syntax-highlight-renderer.ts", () => ({
  createHighlightedBoxDecoration: vi.fn(),
  createHighlightedBoxDecorationMultiline: vi.fn(),
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

function makeDocument(text: string): vscode.TextDocument {
  const lines = text.split("\n");
  const document = {
    uri: { toString: () => "file:///jump-test.ts" },
    version: 1,
    lineCount: lines.length,
    languageId: "typescript",
    getText: (range?: vscode.Range) => {
      if (!range) return text;
      const start = offsetAt(range.start as vscode.Position);
      const end = offsetAt(range.end as vscode.Position);
      return text.slice(start, end);
    },
    offsetAt,
    positionAt: (offset: number) => {
      let remaining = offset;
      for (let line = 0; line < lines.length; line++) {
        const lineLength = lines[line]?.length ?? 0;
        if (remaining <= lineLength) {
          return new vscode.Position(line, remaining);
        }
        remaining -= lineLength + 1;
      }
      const lastLine = Math.max(0, lines.length - 1);
      return new vscode.Position(lastLine, lines[lastLine]?.length ?? 0);
    },
    lineAt: (line: number) => {
      const lineText = lines[line] ?? "";
      return {
        text: lineText,
        range: new vscode.Range(
          new vscode.Position(line, 0),
          new vscode.Position(line, lineText.length),
        ),
      };
    },
  };
  return document as vscode.TextDocument;

  function offsetAt(position: vscode.Position): number {
    let offset = 0;
    for (let line = 0; line < position.line; line++) {
      offset += (lines[line]?.length ?? 0) + 1;
    }
    return offset + position.character;
  }
}

function makeEditor(document: vscode.TextDocument, cursorLine = 0) {
  return {
    document,
    options: { tabSize: 4 },
    selection: { active: new vscode.Position(cursorLine, 0) },
    setDecorations: vi.fn(),
  } as unknown as vscode.TextEditor & {
    setDecorations: ReturnType<typeof vi.fn>;
  };
}

function makeResult(completion = "newValue") {
  return {
    id: "jump-hint",
    startIndex: 6,
    endIndex: 14,
    completion,
    confidence: 0.8,
  };
}

function sentinel(contentText: string): vscode.DecorationOptions {
  return {
    range: new vscode.Range(0, 0, 0, 0),
    renderOptions: { after: { contentText } },
  };
}

function appliedOptions(editor: vscode.TextEditor & { setDecorations: ReturnType<typeof vi.fn> }) {
  return editor.setDecorations.mock.calls.flatMap(
    ([, options]) => options as vscode.DecorationOptions[],
  );
}

async function flushScheduledRefresh(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

let singleLineRenders: Deferred<vscode.DecorationOptions>[];
let multilineRenders: Deferred<vscode.DecorationOptions>[];

function installControlledRenderer(): void {
  vi.mocked(createHighlightedBoxDecoration).mockImplementation(() => {
    const next = singleLineRenders.shift();
    if (!next) throw new Error("No single-line render was queued");
    return next.promise;
  });
  vi.mocked(createHighlightedBoxDecorationMultiline).mockImplementation(() => {
    const next = multilineRenders.shift();
    if (!next) throw new Error("No multiline render was queued");
    return next.promise;
  });
}

beforeEach(() => {
  singleLineRenders = [];
  multilineRenders = [];
  vi.clearAllMocks();
  installControlledRenderer();
});

afterEach(() => {
  (vscode.window as unknown as { activeTextEditor?: unknown }).activeTextEditor = undefined;
  vi.restoreAllMocks();
});

describe("JumpEditManager", () => {
  test("setPendingJumpEdit stays void and an async result paints once it resolves", async () => {
    const document = makeDocument("const oldValue = 1;\nconsole.log(oldValue);");
    const editor = makeEditor(document, 1);
    (vscode.window as unknown as { activeTextEditor?: unknown }).activeTextEditor = editor;
    const render = deferred<vscode.DecorationOptions>();
    singleLineRenders.push(render);
    const manager = new JumpEditManager();

    expect(manager.setPendingJumpEdit(document, makeResult())).toBeUndefined();
    expect(appliedOptions(editor)).toEqual([]);

    const preview = sentinel("resolved-preview");
    render.resolve(preview);
    await Promise.resolve();

    expect(appliedOptions(editor)).toContain(preview);
    const hint = appliedOptions(editor).find((option) =>
      option.renderOptions?.after?.contentText?.includes("Edit at line"),
    );
    expect(hint?.renderOptions?.after?.contentText).toContain("Alt+Tab");
    expect(hint?.renderOptions?.after?.contentText).not.toContain("Tab ✓");
    manager.dispose();
  });

  test.each(["clear", "replacement", "disposal", "version change"] as const)(
    "does not apply a late async result after %s",
    async (lifecycle) => {
      const document = makeDocument("const oldValue = 1;\nconsole.log(oldValue);");
      const editor = makeEditor(document);
      (vscode.window as unknown as { activeTextEditor?: unknown }).activeTextEditor = editor;
      const staleRender = deferred<vscode.DecorationOptions>();
      singleLineRenders.push(staleRender);
      const manager = new JumpEditManager();
      manager.setPendingJumpEdit(document, makeResult());

      let currentRender: Deferred<vscode.DecorationOptions> | undefined;
      if (lifecycle === "clear") {
        manager.clearJumpEdit();
      } else if (lifecycle === "replacement") {
        currentRender = deferred<vscode.DecorationOptions>();
        singleLineRenders.push(currentRender);
        manager.setPendingJumpEdit(document, makeResult("freshValue"));
      } else if (lifecycle === "disposal") {
        manager.dispose();
      } else {
        Reflect.set(document, "version", document.version + 1);
      }

      const stalePreview = sentinel(`stale-${lifecycle}`);
      staleRender.resolve(stalePreview);
      await Promise.resolve();

      expect(appliedOptions(editor)).not.toContain(stalePreview);
      if (currentRender) {
        const currentPreview = sentinel("replacement-preview");
        currentRender.resolve(currentPreview);
        await Promise.resolve();
        expect(appliedOptions(editor)).toContain(currentPreview);
      }
      manager.dispose();
    },
  );

  test("does not apply a late result after the source document edit event", async () => {
    const document = makeDocument("const oldValue = 1;\nconsole.log(oldValue);");
    const editor = makeEditor(document);
    (vscode.window as unknown as { activeTextEditor?: unknown }).activeTextEditor = editor;
    const staleRender = deferred<vscode.DecorationOptions>();
    singleLineRenders.push(staleRender);
    let onDocumentChange: ((event: vscode.TextDocumentChangeEvent) => unknown) | undefined;
    vi.spyOn(vscode.workspace, "onDidChangeTextDocument").mockImplementation(((
      listener: (event: vscode.TextDocumentChangeEvent) => unknown,
    ) => {
      onDocumentChange = listener;
      return { dispose: vi.fn() };
    }) as typeof vscode.workspace.onDidChangeTextDocument);
    const manager = new JumpEditManager();
    manager.setPendingJumpEdit(document, makeResult());

    expect(onDocumentChange).toBeDefined();
    onDocumentChange?.({
      document,
      contentChanges: [{} as vscode.TextDocumentContentChangeEvent],
      reason: undefined,
    });
    const stalePreview = sentinel("edited-document-preview");
    staleRender.resolve(stalePreview);
    await Promise.resolve();

    expect(appliedOptions(editor)).not.toContain(stalePreview);
    manager.dispose();
  });

  test("awaits multiline renderer results before applying them", async () => {
    const document = makeDocument("const oldValue = 1;\nconsole.log(oldValue);");
    const editor = makeEditor(document);
    (vscode.window as unknown as { activeTextEditor?: unknown }).activeTextEditor = editor;
    const render = deferred<vscode.DecorationOptions>();
    multilineRenders.push(render);
    const manager = new JumpEditManager();

    manager.setPendingJumpEdit(document, {
      ...makeResult("firstLine\nsecondLine"),
      endIndex: 6,
    });
    expect(appliedOptions(editor)).toEqual([]);

    const preview = sentinel("multiline-preview");
    render.resolve(preview);
    await Promise.resolve();

    expect(appliedOptions(editor)).toContain(preview);
    expect(createHighlightedBoxDecorationMultiline).toHaveBeenCalledTimes(1);
    manager.dispose();
  });

  test("theme refresh renders the latest result and ignores the older pending result", async () => {
    const document = makeDocument("const oldValue = 1;\nconsole.log(oldValue);");
    const editor = makeEditor(document, 1);
    (vscode.window as unknown as { activeTextEditor?: unknown }).activeTextEditor = editor;
    const oldRender = deferred<vscode.DecorationOptions>();
    const refreshedRender = deferred<vscode.DecorationOptions>();
    singleLineRenders.push(oldRender, refreshedRender);
    const manager = new JumpEditManager();
    manager.setPendingJumpEdit(document, makeResult("latestValue"));

    manager.refreshJumpEditDecorations();
    await flushScheduledRefresh();

    const latestPreview = sentinel("latest-theme-preview");
    refreshedRender.resolve(latestPreview);
    await Promise.resolve();
    const oldPreview = sentinel("old-theme-preview");
    oldRender.resolve(oldPreview);
    await Promise.resolve();

    expect(appliedOptions(editor)).toContain(latestPreview);
    expect(appliedOptions(editor)).not.toContain(oldPreview);
    expect(vi.mocked(createHighlightedBoxDecoration)).toHaveBeenCalledTimes(2);
    manager.dispose();
  });
});
