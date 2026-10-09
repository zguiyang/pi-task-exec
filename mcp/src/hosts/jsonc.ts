import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import type { JSONPath } from "jsonc-parser";

/**
 * Safe JSON/JSONC editing built on `jsonc-parser`.
 *
 * Parsing is strict about syntax (comments and trailing commas are accepted
 * because the host formats allow them) and returns an error instead of a
 * best-effort tree when the file is malformed. Edits are computed as minimal
 * text replacements, so unrelated fields, comments and formatting survive an
 * install/remove.
 */
export type JsonRecord = Record<string, unknown>;

export class JsoncEditError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "JsoncEditError";
    this.code = code;
  }
}

export function parseJsonc(text: string): unknown {
  if (!text.trim()) return {};
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false, allowEmptyContent: false });
  if (errors.length > 0) {
    const first = errors[0] as ParseError;
    throw new JsoncEditError(
      "config_unparseable",
      `JSON/JSONC could not be parsed safely: ${printParseErrorCode(first.error)} at offset ${first.offset}; no file was changed.`,
    );
  }
  return value;
}

export function parseJsoncRoot(text: string): JsonRecord {
  const value = parseJsonc(text);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new JsoncEditError("config_unparseable", "The JSON config root must be an object; no file was changed.");
  }
  return value as JsonRecord;
}

export function readJsonEntry(root: JsonRecord, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as JsonRecord)[segment];
  }
  return current;
}

/** Return `[container, error]`; a non-object container is a shape conflict. */
export function requireObjectContainer(root: JsonRecord, path: readonly string[]): { ok: true; value: JsonRecord | undefined } | { ok: false; reason: string } {
  let current: unknown = root;
  for (const segment of path) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return { ok: false, reason: `The JSON path ${path.join(".")} is not an object.` };
    }
    const next = (current as JsonRecord)[segment];
    if (next === undefined) return { ok: true, value: undefined };
    current = next;
  }
  if (current === null || typeof current !== "object" || Array.isArray(current)) {
    return { ok: false, reason: `The JSON path ${path.join(".")} is not an object.` };
  }
  return { ok: true, value: current as JsonRecord };
}

function detectEol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** Apply a minimal, comment-preserving edit and re-validate the result. */
export function editJsonc(text: string, path: JSONPath, value: unknown): string {
  const source = text.trim() ? text : "{}";
  const edits = modify(source, path, value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: detectEol(source) },
  });
  const result = applyEdits(source, edits);
  parseJsonc(result);
  return result;
}
