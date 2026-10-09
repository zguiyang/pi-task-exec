import { parse as parseTomlDocument, TomlDate } from "smol-toml";

/**
 * Safe, TOML-aware table editing.
 *
 * The document is always parsed with a real TOML parser before and after an
 * edit so a malformed file is refused instead of being rewritten. Table
 * regions are located with a character scanner that understands comments,
 * quoted keys, single/multi-line strings and multi-line arrays, so a naive
 * regex can never delete an adjacent section. Content outside the edited
 * table is copied byte-for-byte, which preserves unrelated values, sections
 * and comments.
 */
export type TomlRecord = Record<string, unknown>;

export class TomlEditError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "TomlEditError";
    this.code = code;
  }
}

export function parseToml(text: string): TomlRecord {
  let value: unknown;
  try {
    value = parseTomlDocument(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TomlEditError("config_unparseable", `TOML could not be parsed safely: ${message}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TomlEditError("config_unparseable", "The TOML root must be a table.");
  }
  return value as TomlRecord;
}

export function readTomlEntry(root: TomlRecord, path: readonly string[]): TomlRecord | undefined {
  let current: unknown = root;
  for (const segment of path) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as TomlRecord)[segment];
  }
  if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
  return current as TomlRecord;
}

interface HeaderSpan {
  path: string[];
  lineStart: number;
  regionEnd: number;
}

function parseTomlKeyPath(raw: string): string[] | null {
  const segments: string[] = [];
  let index = 0;
  const length = raw.length;
  while (index < length) {
    while (index < length && /\s/.test(raw[index] ?? "")) index += 1;
    if (index >= length) break;
    const character = raw[index] ?? "";
    let value = "";
    if (character === '"') {
      index += 1;
      while (index < length && raw[index] !== '"') {
        if (raw[index] === "\\") {
          const escaped = raw[index + 1];
          index += 2;
          if (escaped === "n") value += "\n";
          else if (escaped === "t") value += "\t";
          else if (escaped === "r") value += "\r";
          else if (escaped === '"') value += '"';
          else if (escaped === "\\") value += "\\";
          else if (escaped === "u") {
            const hex = raw.slice(index, index + 4);
            value += String.fromCharCode(Number.parseInt(hex, 16) || 0);
            index += 4;
          } else value += escaped ?? "";
          continue;
        }
        value += raw[index] ?? "";
        index += 1;
      }
      index += 1;
    } else if (character === "'") {
      index += 1;
      while (index < length && raw[index] !== "'") {
        value += raw[index] ?? "";
        index += 1;
      }
      index += 1;
    } else {
      while (index < length && raw[index] !== "." && !/\s/.test(raw[index] ?? "")) {
        value += raw[index] ?? "";
        index += 1;
      }
      if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
    }
    segments.push(value);
    while (index < length && /\s/.test(raw[index] ?? "")) index += 1;
    if (index < length && raw[index] === ".") {
      index += 1;
      continue;
    }
    if (index < length) return null;
  }
  return segments;
}

function findHeaderClose(text: string, start: number, array: boolean): number {
  let index = start;
  const length = text.length;
  while (index < length) {
    const character = text[index] ?? "";
    if (character === '"') {
      index += 1;
      while (index < length) {
        if (text[index] === "\\") {
          index += 2;
          continue;
        }
        if (text[index] === '"') break;
        index += 1;
      }
      index += 1;
      continue;
    }
    if (character === "'") {
      index += 1;
      while (index < length && text[index] !== "'") index += 1;
      index += 1;
      continue;
    }
    if (character === "]") {
      if (!array) return index;
      if (text[index + 1] === "]") return index;
    }
    if (character === "\n") return -1;
    index += 1;
  }
  return -1;
}

type ScanState = "normal" | "basic" | "literal" | "mlbasic" | "mlliteral" | "comment";

/** Character-level scanner that returns every table header and its line span. */
function scanHeaders(text: string): HeaderSpan[] {
  const spans: HeaderSpan[] = [];
  const length = text.length;
  let index = 0;
  let lineStart = 0;
  let lineHasContent = false;
  let arrayDepth = 0;
  let braceDepth = 0;
  let state: ScanState = "normal";

  while (index < length) {
    const character = text[index] ?? "";
    if (state === "comment") {
      if (character === "\n") {
        state = "normal";
        lineStart = index + 1;
        lineHasContent = false;
      }
      index += 1;
      continue;
    }
    if (state === "basic") {
      if (character === "\\") {
        index += 2;
        continue;
      }
      if (character === '"') state = "normal";
      index += 1;
      continue;
    }
    if (state === "literal") {
      if (character === "'") state = "normal";
      index += 1;
      continue;
    }
    if (state === "mlbasic") {
      if (character === '"' && text[index + 1] === '"' && text[index + 2] === '"') {
        state = "normal";
        index += 3;
        continue;
      }
      index += 1;
      continue;
    }
    if (state === "mlliteral") {
      if (character === "'" && text[index + 1] === "'" && text[index + 2] === "'") {
        state = "normal";
        index += 3;
        continue;
      }
      index += 1;
      continue;
    }
    if (character === "\n") {
      lineStart = index + 1;
      lineHasContent = false;
      index += 1;
      continue;
    }
    if (character === " " || character === "\t" || character === "\r") {
      index += 1;
      continue;
    }
    if (character === "#") {
      state = "comment";
      index += 1;
      continue;
    }
    if (character === '"') {
      if (text[index + 1] === '"' && text[index + 2] === '"') {
        state = "mlbasic";
        index += 3;
      } else {
        state = "basic";
        index += 1;
      }
      lineHasContent = true;
      continue;
    }
    if (character === "'") {
      if (text[index + 1] === "'" && text[index + 2] === "'") {
        state = "mlliteral";
        index += 3;
      } else {
        state = "literal";
        index += 1;
      }
      lineHasContent = true;
      continue;
    }
    if (character === "[" && !lineHasContent && arrayDepth === 0 && braceDepth === 0) {
      const isArray = text[index + 1] === "[";
      const openLength = isArray ? 2 : 1;
      const nameStart = index + openLength;
      const closeIndex = findHeaderClose(text, nameStart, isArray);
      if (closeIndex < 0) {
        lineHasContent = true;
        index += 1;
        continue;
      }
      const path = parseTomlKeyPath(text.slice(nameStart, closeIndex));
      let lineEnd = closeIndex + openLength;
      while (lineEnd < length && text[lineEnd] !== "\n") lineEnd += 1;
      const nextLine = lineEnd < length ? lineEnd + 1 : length;
      if (path) spans.push({ path, lineStart, regionEnd: length });
      index = nextLine;
      lineStart = nextLine;
      lineHasContent = false;
      continue;
    }
    if (character === "[") {
      arrayDepth += 1;
      lineHasContent = true;
      index += 1;
      continue;
    }
    if (character === "]") {
      if (arrayDepth > 0) arrayDepth -= 1;
      lineHasContent = true;
      index += 1;
      continue;
    }
    if (character === "{") {
      braceDepth += 1;
      lineHasContent = true;
      index += 1;
      continue;
    }
    if (character === "}") {
      if (braceDepth > 0) braceDepth -= 1;
      lineHasContent = true;
      index += 1;
      continue;
    }
    lineHasContent = true;
    index += 1;
  }

  for (let header = 0; header < spans.length; header += 1) {
    const next = spans[header + 1];
    (spans[header] as HeaderSpan).regionEnd = next ? next.lineStart : length;
  }
  return spans;
}

function serializeTomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function serializeTomlValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TomlEditError("unsupported_toml_value", "Cannot serialise a non-finite number.");
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return `[${value.map((item) => serializeTomlValue(item)).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as TomlRecord).map(
      ([key, nested]) => `${serializeTomlKey(key)} = ${serializeTomlValue(nested)}`,
    );
    return `{ ${entries.join(", ")} }`;
  }
  throw new TomlEditError("unsupported_toml_value", `Cannot serialise a ${value === null ? "null" : typeof value} TOML value.`);
}

function serializeTomlTable(path: readonly string[], entry: TomlRecord, preferredOrder: readonly string[]): string {
  const header = `[${path.map((segment) => serializeTomlKey(segment)).join(".")}]`;
  const keys = Object.keys(entry);
  const ordered = [
    ...preferredOrder.filter((key) => keys.includes(key)),
    ...keys.filter((key) => !preferredOrder.includes(key)).sort(),
  ];
  const lines = [header];
  for (const key of ordered) {
    lines.push(`${serializeTomlKey(key)} = ${serializeTomlValue(entry[key])}`);
  }
  return lines.join("\n");
}

function matchingHeaders(text: string, path: readonly string[]): HeaderSpan[] {
  const spans = scanHeaders(text);
  return spans.filter((span) => {
    if (span.path.length < path.length) return false;
    for (let index = 0; index < path.length; index += 1) {
      if (span.path[index] !== path[index]) return false;
    }
    return true;
  });
}

function isMainHeader(span: HeaderSpan, path: readonly string[]): boolean {
  return span.path.length === path.length;
}

/** Append a table block to the end of a document with one blank separator line. */
function appendTable(text: string, block: string): string {
  const trimmed = text.replace(/\s*$/, "");
  return `${trimmed.length > 0 ? `${trimmed}\n\n` : ""}${block}\n`;
}

export function upsertTomlTable(text: string, path: readonly string[], entry: TomlRecord, preferredOrder: readonly string[]): string {
  const header = path[path.length - 1] ?? "";
  const parsed = text.trim() ? parseToml(text) : {};
  const existing = header ? readTomlEntry(parsed, path) : undefined;
  const merged: TomlRecord = { ...(existing ?? {}), ...entry };
  const block = serializeTomlTable(path, merged, preferredOrder);
  if (!text.trim()) return `${block}\n`;

  const spans = matchingHeaders(text, path);
  if (spans.length === 0) {
    const next = appendTable(text, block);
    parseToml(next);
    return next;
  }

  const main = spans.find((span) => isMainHeader(span, path));
  const edits = spans
    .filter((span) => span !== main)
    .map((span) => ({ start: span.lineStart, end: span.regionEnd, replacement: "" }));
  if (main) edits.push({ start: main.lineStart, end: main.regionEnd, replacement: `${block}\n` });
  else edits.push({ start: text.length, end: text.length, replacement: `${text.endsWith("\n") ? "" : "\n"}${block}\n` });

  edits.sort((left, right) => right.start - left.start);
  let result = text;
  for (const edit of edits) {
    result = `${result.slice(0, edit.start)}${edit.replacement}${result.slice(edit.end)}`;
  }
  parseToml(result);
  return result;
}

export function removeTomlTable(text: string, path: readonly string[]): { content: string; found: boolean } {
  if (!text.trim()) return { content: text, found: false };
  const parsed = parseToml(text);
  const header = path[path.length - 1] ?? "";
  const present = header ? readTomlEntry(parsed, path) !== undefined : false;
  const spans = matchingHeaders(text, path);
  if (spans.length === 0) return { content: text, found: present };
  const edits = spans
    .map((span) => ({ start: span.lineStart, end: span.regionEnd }))
    .sort((left, right) => right.start - left.start);
  let result = text;
  for (const edit of edits) {
    result = `${result.slice(0, edit.start)}${result.slice(edit.end)}`;
  }
  parseToml(result);
  return { content: result, found: true };
}

export { TomlDate };
