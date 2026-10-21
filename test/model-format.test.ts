import { describe, expect, test } from "vite-plus/test";

import { detectModelFormat } from "~/api/model-format.ts";
import type { AutocompleteRequest } from "~/api/schemas.ts";
import {
  buildZeta2Prompt,
  selectZetaCursorWindowFromLineProvider,
  ZETA2_1_EOS_MARKER,
  ZETA2_CURSOR_MARKER,
} from "~/api/zeta2-prompt.ts";

function makeRequest(overrides: Partial<AutocompleteRequest> = {}): AutocompleteRequest {
  const fileContents = "line0\nline1\nline2 cursor here\nline3\nline4\n";
  const cursorLineStart = "line0\nline1\n".length;
  const cursorPosition = cursorLineStart + "line2 ".length;
  return {
    debug_info: "test",
    repo_name: "demo",
    file_path: "src/foo.ts",
    file_contents: fileContents,
    original_file_contents: fileContents,
    cursor_position: cursorPosition,
    recent_changes: "",
    changes_above_cursor: false,
    multiple_suggestions: false,
    file_chunks: [],
    retrieval_chunks: [],
    editor_diagnostics: [],
    recent_user_actions: [],
    use_bytes: true,
    ...overrides,
  };
}

describe("detectModelFormat", () => {
  test.each([
    "zeta-2.1",
    "zed-industries/zeta-2.1",
    "zeta2.1-q4",
    "Zeta_2_1",
    "local-model-alias",
    "",
    "sweepai/sweep-next-edit",
    "zed-industries/zeta2",
    "seedcoder-8b-edit",
  ])("uses Zeta 2.1 for server model name %j", (modelName) => {
    expect(detectModelFormat(modelName)).toBe("zeta2.1");
  });
});

describe("buildZeta2Prompt", () => {
  test("default editable region uses the 350 estimated-token budget around the cursor", () => {
    const lines = Array.from(
      { length: 100 },
      (_, i) => `${i.toString().padStart(2, "0")}:${"x".repeat(96)}`,
    );
    const fileContents = `${lines.join("\n")}\n`;
    const cursorPos = lines.slice(0, 50).join("\n").length + 1;
    const result = buildZeta2Prompt(
      makeRequest({ file_contents: fileContents, cursor_position: cursorPos }),
    );

    // Ten complete 100-byte lines fit under 350 * 3 bytes. Starting
    // with the cursor yields five lines before, the cursor, and four after.
    expect(result.windowStartLine).toBe(45);
    expect(result.windowEndLine).toBe(55);
  });

  test("Zeta 2.1 estimated-token profile is configurable without tokenization", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `[${i}]${"x".repeat(25)}`);
    const fileContents = `${lines.join("\n")}\n`;
    const cursorPosition = lines.slice(0, 50).join("\n").length + 1;
    const result = buildZeta2Prompt(
      makeRequest({
        file_contents: fileContents,
        original_file_contents: fileContents,
        cursor_position: cursorPosition,
      }),
      {
        editableTokens: 50,
        contextTokens: 40,
        maxRelatedChunks: 0,
      },
    );

    expect(result.windowStartLine).toBe(48);
    expect(result.windowEndLine).toBe(53);
    expect(result.prompt).toContain(`${lines[46]}\n${lines[47]}\n<|marker_1|>`);
    expect(result.prompt).toContain(`<[fim-suffix]>${lines[53]}\n${lines[54]}`);
    expect(result.prompt).not.toContain(lines[45] ?? "");
    expect(result.prompt).not.toContain(lines[55] ?? "");
  });

  test("estimated-token windows use UTF-8 bytes and never split long lines", () => {
    const lines = ["short-before", "я".repeat(120), "cursor", "short-after"];
    const fileContents = lines.join("\n");
    const cursorPosition = Buffer.byteLength(`${lines[0]}\n${lines[1]}\n`, "utf8") + 3;
    const result = buildZeta2Prompt(
      makeRequest({
        file_contents: fileContents,
        original_file_contents: fileContents,
        cursor_position: cursorPosition,
      }),
      {
        editableTokens: 20,
        contextTokens: 0,
        maxRelatedChunks: 0,
      },
    );

    expect(result.windowStartLine).toBe(2);
    expect(result.windowEndLine).toBe(4);
    expect(result.prompt).not.toContain(lines[1] ?? "");
    expect(result.prompt).toContain("cur<|user_cursor|>sor");
    expect(result.prompt).toContain("short-after");
  });

  test("line-provider selection only reads the nearby excerpt", () => {
    const readLines = new Set<number>();
    const window = selectZetaCursorWindowFromLineProvider(50_000, 25_000, 350, 150, (line) => {
      readLines.add(line);
      return "x".repeat(99);
    });

    expect(window).toEqual({
      editableStart: 24_995,
      editableEnd: 25_005,
      contextStart: 24_993,
      contextEnd: 25_007,
    });
    expect(readLines.size).toBeLessThan(20);
  });

  test("Zeta 2.1 prefers targeted retrieval and keeps far same-file snippets", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `[${i}]${"x".repeat(35)}`);
    const fileContents = `${lines.join("\n")}\n`;
    const cursorPosition = lines.slice(0, 50).join("\n").length + 1;
    const result = buildZeta2Prompt(
      makeRequest({
        file_contents: fileContents,
        original_file_contents: fileContents,
        cursor_position: cursorPosition,
        recent_changes: "File: src/foo.ts:\n@@\n-old\n+new",
        symbol_outline:
          "active_symbol: CTextDraw::Draw\nnearby_functions:\n- line 300: CTextDraw::Draw [active]",
        retrieval_chunks: [
          {
            file_path: "src/foo.ts",
            start_line: 40,
            end_line: 42,
            content: "overlapping current-file retrieval",
          },
          {
            file_path: "src/foo.ts",
            start_line: 1,
            end_line: 3,
            content: "far current-file definition",
          },
          {
            file_path: "src/types.ts",
            start_line: 10,
            end_line: 12,
            content: "external LSP definition",
          },
          {
            file_path: "clipboard.txt",
            start_line: 1,
            end_line: 1,
            content: "clipboard context",
          },
        ],
        file_chunks: [
          {
            file_path: "src/recent.ts",
            start_line: 1,
            end_line: 2,
            content: "recent visible buffer",
          },
        ],
      }),
      { editableTokens: 350, maxRelatedChunks: 4 },
    );

    expect(result.prompt).not.toContain("overlapping current-file retrieval");
    expect(result.prompt).toContain("far current-file definition");
    expect(result.prompt).toContain("external LSP definition");
    expect(result.prompt).toContain("recent visible buffer");
    expect(result.prompt).toContain("clipboard context");

    const farDefinition = result.prompt.indexOf("far current-file definition");
    const outline = result.prompt.indexOf("<filename>context/outline");
    const editHistory = result.prompt.indexOf("<filename>edit_history");
    const cursorFile = result.prompt.lastIndexOf("<filename>src/foo.ts");
    expect(farDefinition).toBeGreaterThanOrEqual(0);
    expect(editHistory).toBeGreaterThan(farDefinition);
    expect(outline).toBeGreaterThan(editHistory);
    expect(cursorFile).toBeGreaterThan(outline);
    expect(result.contextStats?.relatedFiles).toBeGreaterThan(0);
    expect(result.contextStats?.outline).toBeGreaterThan(0);
  });

  test("always uses the Zed training-template context order", () => {
    const chunks = [
      {
        file_path: "src/zeta.ts",
        start_line: 8,
        end_line: 9,
        content: "const zetaRelated = true;",
      },
      {
        file_path: "src/alpha.ts",
        start_line: 2,
        end_line: 3,
        content: "const alphaRelated = true;",
      },
    ];
    const request = makeRequest({
      recent_changes: "File: src/foo.ts:\n@@\n-old\n+new",
      retrieval_chunks: chunks,
      editor_diagnostics: [
        {
          line: 3,
          start_offset: 12,
          end_offset: 17,
          severity: "error",
          message: "volatile diagnostic",
          timestamp: 1,
        },
      ],
    });
    const result = buildZeta2Prompt(request);
    const zeta = result.prompt.indexOf("<filename>src/zeta.ts");
    const alpha = result.prompt.indexOf("<filename>src/alpha.ts");
    const history = result.prompt.indexOf("<filename>edit_history");
    const diagnostics = result.prompt.indexOf("<filename>diagnostics");
    const active = result.prompt.lastIndexOf("<filename>src/foo.ts");

    expect(result.prompt.indexOf("<[fim-suffix]>")).toBe(0);
    expect(zeta).toBeGreaterThanOrEqual(0);
    expect(alpha).toBeGreaterThan(zeta);
    expect(history).toBeGreaterThan(alpha);
    expect(diagnostics).toBeGreaterThan(history);
    expect(active).toBeGreaterThan(diagnostics);
    expect(result.prompt).toContain("volatile diagnostic");
  });

  test("Zeta 2.1 emits numbered boundaries around one excerpt", () => {
    const result = buildZeta2Prompt(makeRequest());
    expect(result.format).toBe("zeta2.1");
    expect(result.stopTokens).toEqual([ZETA2_1_EOS_MARKER]);

    // This short excerpt has two numbered boundaries and no git-conflict
    // scaffolding.
    expect(result.prompt).toContain("<|marker_1|>\n");
    expect(result.prompt).toContain("<|marker_2|>\n");
    expect(result.prompt).not.toContain("<<<<<<< CURRENT");
    expect(result.prompt).not.toContain("=======");

    // Order: <|marker_1|> ... <|user_cursor|> ... <|marker_2|> ... <[fim-middle]>
    const m1 = result.prompt.indexOf("<|marker_1|>\n");
    const cursorIdx = result.prompt.indexOf(ZETA2_CURSOR_MARKER);
    const m2 = result.prompt.indexOf("<|marker_2|>\n");
    const middleIdx = result.prompt.indexOf("<[fim-middle]>");
    expect(m1).toBeGreaterThan(0);
    expect(cursorIdx).toBeGreaterThan(m1);
    expect(cursorIdx).toBeLessThan(m2);
    expect(middleIdx).toBeGreaterThan(m2);
    expect(result.prompt.endsWith("<[fim-middle]>")).toBe(true);
    expect(result.regions).toEqual([{ startLine: 0, endLine: 6, isPrimary: true }]);
    expect(result.markerBoundaryLines).toEqual([0, 5]);
  });

  test("Zeta 2.1 uses V0318 hard-cap boundaries, not diagnostics", () => {
    const lines = Array.from(
      { length: 80 },
      (_, i) => `${i.toString().padStart(2, "0")}:${"x".repeat(16)}`,
    );
    const fileContents = `${lines.join("\n")}\n`;
    const cursorPosition = lines.slice(0, 40).join("\n").length + 1;
    const result = buildZeta2Prompt(
      makeRequest({
        file_contents: fileContents,
        original_file_contents: fileContents,
        cursor_position: cursorPosition,
        editor_diagnostics: [
          {
            line: 5,
            start_offset: 0,
            end_offset: 5,
            severity: "error",
            message: "distant error",
            timestamp: 1,
          },
        ],
      }),
      {
        diagRadius: 0,
        editableTokens: 207,
        contextTokens: 0,
      },
    );

    // Editable range is [25, 56). With no blank lines, V0318 inserts a
    // hard boundary after 16 lines: 25, 41, 56. The diagnostic on line 5
    // remains context and does not create an editable region.
    expect(result.regions).toEqual([{ startLine: 25, endLine: 56, isPrimary: true }]);
    expect(result.markerBoundaryLines).toEqual([25, 41, 56]);
    expect(result.prompt).toContain("<|marker_3|>");
    expect(result.prompt).not.toContain("<|marker_4|>");
    expect(result.stopTokens).toEqual([ZETA2_1_EOS_MARKER]);
    expect(result.stopTokens.some((token) => token.includes("marker_"))).toBe(false);
  });

  test("Zeta 2.1 prefers a blank-line block boundary", () => {
    const lines = Array.from(
      { length: 50 },
      (_, i) => `${i.toString().padStart(2, "0")}:${"x".repeat(16)}`,
    );
    // Cursor line 25 gives editable range [10, 41). A blank line at
    // relative row 7 makes line 18 a preferred block start.
    lines[17] = "";
    const fileContents = `${lines.join("\n")}\n`;
    const cursorPosition = lines.slice(0, 25).join("\n").length + 1;
    const result = buildZeta2Prompt(
      makeRequest({
        file_contents: fileContents,
        original_file_contents: fileContents,
        cursor_position: cursorPosition,
      }),
      {
        editableTokens: 201,
        contextTokens: 0,
      },
    );

    expect(result.markerBoundaryLines?.[0]).toBe(10);
    expect(result.markerBoundaryLines?.[1]).toBe(18);
    expect(result.markerBoundaryLines?.at(-1)).toBe(41);
  });

  test("Zeta 2.1 crops active-file context without tokenization", () => {
    const lines = Array.from(
      { length: 100 },
      (_, i) => `unique_${i.toString().padStart(2, "0")}_${"x".repeat(19)}`,
    );
    const fileContents = `${lines.join("\n")}\n`;
    const cursorPosition = lines.slice(0, 50).join("\n").length + 1;
    const result = buildZeta2Prompt(
      makeRequest({
        file_contents: fileContents,
        original_file_contents: fileContents,
        cursor_position: cursorPosition,
      }),
      {
        editableTokens: 50,
        contextTokens: 40,
      },
    );

    // Five editable lines plus four surrounding context lines.
    expect(result.prompt).toContain(`${lines[46]}\n`);
    expect(result.prompt).toContain(`${lines[54]}\n`);
    expect(result.prompt).not.toContain(`${lines[45]}\n`);
    expect(result.prompt).not.toContain(`${lines[55]}\n`);
  });
});
