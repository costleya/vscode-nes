// Shared document coordinates and diagnostic rendering for model prompt formats.
import type { MessageTransform } from "~/core/config.ts";
import type { EditorDiagnostic } from "./schemas.ts";

export function splitLines(text: string): string[] {
  return text.split("\n");
}

export function computeLineByteOffsets(lines: string[]): number[] {
  // oxlint-disable-next-line unicorn/no-new-array -- Preallocate the lookup table; every slot is assigned below.
  const offsets = new Array<number>(lines.length + 1);
  offsets[0] = 0;
  let off = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineStr = lines[i] ?? "";
    off += Buffer.byteLength(lineStr, "utf8") + 1; // +1 for '\n'
    offsets[i + 1] = off;
  }
  return offsets;
}

export function locateCursor(
  lineOffsets: number[],
  cursorByte: number,
): { line: number; col: number } {
  if (cursorByte <= 0) return { line: 0, col: 0 };
  for (let i = 0; i < lineOffsets.length - 1; i++) {
    const start = lineOffsets[i] ?? 0;
    const next = lineOffsets[i + 1] ?? start;
    // Cursor at the trailing '\n' of line i is treated as col=lineLen.
    if (cursorByte < next) {
      return { line: i, col: cursorByte - start };
    }
  }
  const last = Math.max(0, lineOffsets.length - 2);
  const start = lineOffsets[last] ?? 0;
  return { line: last, col: cursorByte - start };
}

// Render diagnostics as a comment block in the document's language. Each
// diagnostic produces a gcc/clang-style "[severity] line N:col: message"
// header followed by the offending source line trimmed of indentation.
// The model has seen this pattern in compiler output during pretraining,
// so wrapping it in the file's comment syntax (so it reads as a TODO
// block in the code) measurably increases attention to the diagnostic
// when generating the edit.
export function renderDiagnosticsAsComments(
  diagnostics: EditorDiagnostic[],
  commentPrefix: string,
  lines: string[],
  lineOffsets: number[],
  messageTransforms: MessageTransform[] = [],
): string {
  let out = `${commentPrefix} FIXME: Fix these issues:\n`;
  for (const d of diagnostics) {
    const lineIdx = d.line - 1;
    const lineStart = lineOffsets[lineIdx] ?? 0;
    const col = d.start_offset >= lineStart ? d.start_offset - lineStart + 1 : 1;
    const msg = normalizeDiagnosticMessage(d.message, messageTransforms);
    out += `${commentPrefix} [${d.severity}] line ${d.line}:${col}: ${msg}\n`;
    const source = (lines[lineIdx] ?? "").trim();
    if (source !== "") out += `${commentPrefix}   ${source}\n`;
  }
  return out;
}

// Rephrase LSP diagnostic messages into a more directive form so a small
// model is more likely to act on them:
//
//   * "...; did you mean 'X'?"     →  "use 'X' instead (...)"
//   * "(fix available)" suffix     →  stripped (IDE-internal noise)
//   * "...; consider using 'X'"    →  "use 'X' instead (...)"
//
// User-supplied regex transforms are applied AFTER these built-ins so a
// project can patch in linter-specific phrasings without losing the
// defaults. Non-destructive on no-match: original description survives
// in parens so the model still has the context.
export function normalizeDiagnosticMessage(
  message: string,
  userTransforms: MessageTransform[] = [],
): string {
  let msg = message.trim();
  // clangd / TS append "(fix available)" / "(fixes available)" when a
  // quickfix exists. The model has no IDE to invoke; the suffix only
  // telegraphs "ignore me, the IDE will handle it".
  msg = msg.replace(/\s*\((?:fix|fixes) available\)\s*$/i, "").trim();

  // Common directive-extraction patterns from clang/TypeScript/Rust.
  // Each capture group #1 is the rest of the description, #2 is the
  // suggested replacement.
  const patterns = [
    /^(.*?)[;,]?\s*did you mean ['"`]([^'"`]+)['"`]\??\s*$/i,
    /^(.*?)[;,]?\s*consider using ['"`]([^'"`]+)['"`]\.?\s*$/i,
    /^(.*?)[;,]?\s*replace with ['"`]([^'"`]+)['"`]\.?\s*$/i,
  ];
  for (const re of patterns) {
    const m = msg.match(re);
    if (m) {
      const rest = (m[1] ?? "").trim().replace(/[;,.]+$/, "");
      const suggestion = m[2] ?? "";
      msg = rest === "" ? `use '${suggestion}' instead` : `use '${suggestion}' instead (${rest})`;
      break;
    }
  }

  // Apply user-supplied transforms in declaration order. Invalid
  // regexes are skipped silently so a single bad config entry doesn't
  // break the whole pipeline.
  for (const t of userTransforms) {
    try {
      const re = new RegExp(t.pattern, t.flags);
      msg = msg.replace(re, t.replacement);
    } catch {
      // ignore malformed pattern
    }
  }

  return msg;
}

// Strip `<commentPrefix> <marker> …` suffixes the prompt builder
// injected via injectInlineDiagnostics, so the line-diff sees the
// model's output as if those comments had never been there. Mutates
// the array in place.
//
// We anchor on the literal substring `<commentPrefix> <marker>` (e.g.
// `// BUG: LSP error here`). The default marker is a phrase humans
// essentially never write, so matching it pinpoints our injection
// while leaving user-authored TODO/FIXME comments alone. Anchoring on
// a static phrase rather than message text is robust to small models
// paraphrasing the rest of the comment. No-op when no injection
// happened or the prompt didn't carry the marker.
export function stripInjectedFixmesFromLines(
  lines: string[],
  injectedFixmeMessages: string[] | undefined,
  commentPrefix: string | undefined,
  inlineDiagnosticsMarker: string | undefined,
): void {
  if (!injectedFixmeMessages || injectedFixmeMessages.length === 0) return;
  if (!commentPrefix || !inlineDiagnosticsMarker) return;
  const marker = `${commentPrefix} ${inlineDiagnosticsMarker}`;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const idx = line.indexOf(marker);
    if (idx < 0) continue;
    // Trim trailing whitespace between the original line content and
    // our injected marker (the injection shape was
    // `${line} ${commentPrefix} ${marker} … - …`).
    let cut = idx;
    while (cut > 0 && (line[cut - 1] === " " || line[cut - 1] === "\t")) {
      cut--;
    }
    lines[i] = line.slice(0, cut);
  }
}
