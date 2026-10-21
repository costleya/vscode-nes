export type ModelFormat = "zeta2.1";

export interface PromptLine {
  startByte: number;
  content: string;
}

// One editable region inside the prompt. Zeta2.1 subdivides its single
// contiguous region with markerBoundaryLines.
export interface EditRegion {
  // 0-indexed half-open line range in the document.
  startLine: number;
  endLine: number;
  // True for the region that contains the cursor — drives ghost-text
  // vs. jump-edit classification on the editor side.
  isPrimary: boolean;
}

export interface PromptContextStats {
  activeFileSuffix?: number;
  rules?: number;
  relatedFiles?: number;
  outline?: number;
  editHistory?: number;
  diagnostics?: number;
  activeFilePrefixAndEditable?: number;
}

// Common output of every prompt builder. The response parser uses
// windowStartLine / windowEndLine + lines + cursorLineByteOffsets to map
// the model's text output back to a byte-offset edit on the user's buffer.
export interface ModelPrompt {
  prompt: string;
  // Cheap observability for prompt composition. Values are UTF-16
  // character counts, not tokenizer counts, so collecting them does not
  // add model/tokenizer work to the VS Code extension host.
  contextStats?: PromptContextStats;
  // Text the model continues from; empty for Zeta 2.1 FIM.
  prefill: string;
  format: ModelFormat;
  stopTokens: string[];
  // Line range (0-indexed half-open) available for replacement.
  windowStartLine: number;
  windowEndLine: number;
  // Always non-empty. Zeta 2.1 uses one contiguous region.
  regions: EditRegion[];
  // Absolute document line boundaries corresponding to <|marker_1|>,
  // <|marker_2|>, ... in a Zeta2.1 prompt. Interior boundaries divide the
  // editable excerpt into Zed V0318-style blocks. At a newline-terminated
  // EOF the last entry is the logical EOF line, before splitLines' phantom
  // trailing empty element.
  markerBoundaryLines?: number[];
  // Full file lines + byte offsets. The response parser indexes into these
  // to produce a UTF-8 byte-offset edit. These reflect the *undecorated*
  // document; if injectInlineDiagnostics added FIXME suffixes, those live
  // in the rendered prompt only and are stripped from the response via
  // injectedFixmeMessages.
  lines: PromptLine[];
  cursorLineByteOffsets: number[];
  // Diagnostic messages whose inline `<commentPrefix> <marker>` form
  // was injected into the rendered prompt. Non-empty signals the
  // response parser to run the strip; the array's contents are
  // retained for diagnostics/debug logging.
  injectedFixmeMessages?: string[];
  // Comment prefix used to wrap the injected FIXMEs ("//", "#", "--").
  // Combined with inlineDiagnosticsMarker to form the strip anchor.
  commentPrefix?: string;
  // Marker phrase between the comment prefix and the diagnostic
  // body — e.g. "BUG: LSP error here". The literal substring
  // `<commentPrefix> <marker>` is the strip anchor, so this must
  // match what the prompt builder emitted.
  inlineDiagnosticsMarker?: string;
}

// Server model names are aliases, independent of the wire protocol. Add
// future supported formats here alongside the provider registry.
export function detectModelFormat(_modelName: string): ModelFormat {
  return "zeta2.1";
}
