const JSON_FENCE_RE = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/u;

export const stripJsonFenceWrapper = (s: string): string => {
  const match = s.match(JSON_FENCE_RE);
  return match !== null && match[1] !== undefined ? match[1].trim() : s.trim();
};

export const extractJsonObjectSlice = (s: string): string => {
  const trimmed = stripJsonFenceWrapper(s);
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
};

export const repairJsonTextControlChars = (s: string): string =>
  s.replace(/"((?:[^"\\]|\\.)*)"/gu, (_match, content: string) => {
    // eslint-disable-next-line no-control-regex
    const escaped = content.replace(/[\u0000-\u001F]/gu, (ch) => {
      switch (ch) {
        case "\n":
          return "\\n";
        case "\r":
          return "\\r";
        case "\t":
          return "\\t";
        default:
          return " ";
      }
    });
    return `"${escaped}"`;
  });

export const removeTrailingJsonCommas = (s: string): string => s.replace(/,\s*([}\]])/gu, "$1");

export const salvageLooseJsonTextField = (raw: string, field: string): string | null => {
  const slice = extractJsonObjectSlice(raw);
  const key = `"${field}"`;
  const keyIndex = slice.indexOf(key);
  if (keyIndex < 0) return null;

  let valueStart = keyIndex + key.length;
  while (valueStart < slice.length && /[\s:]/u.test(slice[valueStart]!)) valueStart += 1;
  if (slice[valueStart] !== '"') return null;
  valueStart += 1;

  const strict = extractJsonStringField(slice, field);
  const closingBrace = slice.lastIndexOf("}");
  if (closingBrace > valueStart) {
    const tail = slice.slice(valueStart, closingBrace).trimEnd();
    if (tail.endsWith('"')) {
      const loose = tail.slice(0, -1);
      if (loose.length >= (strict?.length ?? 0)) return loose;
    }
  }

  if (strict !== null && strict.trim().length > 0) return strict;

  const partial = slice
    .slice(valueStart)
    .replace(/"\s*\}\s*$/u, "")
    .replace(/"\s*$/u, "")
    .trim();
  return partial.length > 0 ? partial : null;
};

export const extractJsonStringField = (raw: string, field: string): string | null => {
  const key = `"${field}"`;
  const keyIndex = raw.indexOf(key);
  if (keyIndex < 0) return null;

  let index = keyIndex + key.length;
  while (index < raw.length && /[\s:]/u.test(raw[index]!)) index += 1;
  if (raw[index] !== '"') return null;
  index += 1;

  let value = "";
  while (index < raw.length) {
    const char = raw[index]!;
    if (char === "\\") {
      const next = raw[index + 1];
      if (next === undefined) break;
      const escapes: Record<string, string> = {
        n: "\n",
        r: "\r",
        t: "\t",
        '"': '"',
        "\\": "\\",
      };
      value += escapes[next] ?? next;
      index += 2;
      continue;
    }
    if (char === '"') return value;
    value += char;
    index += 1;
  }
  return null;
};

export const parseJsonWithRepairs = (raw: string): unknown => {
  const candidates = [
    raw,
    repairJsonTextControlChars(raw),
    removeTrailingJsonCommas(repairJsonTextControlChars(raw)),
    extractJsonObjectSlice(raw),
    removeTrailingJsonCommas(repairJsonTextControlChars(extractJsonObjectSlice(raw))),
  ];

  const seen = new Set<string>();
  let lastError: Error | null = null;
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      return JSON.parse(candidate);
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError ?? new Error("Invalid JSON");
};

/**
 * Attempt to recover complete JSON objects from a partial/truncated array.
 * When the LLM response is cut off mid-array (e.g. truncated JSON),
 * this extracts every complete `{...}` object that can be parsed.
 *
 * Example input: `[{"index":1,"text":"Hello"},{"index":2,"text":"Wor`
 * Returns: `[{index: 1, text: "Hello"}]`
 */
export const salvagePartialJsonArray = (raw: string): unknown[] => {
  const s = stripJsonFenceWrapper(raw).trim();
  const start = s.indexOf("[");
  if (start < 0) return [];

  const items: unknown[] = [];
  let pos = start + 1;

  while (pos < s.length) {
    // Skip whitespace and commas between array elements
    while (pos < s.length && /[\s,]/.test(s[pos]!)) pos += 1;
    if (pos >= s.length) break;
    if (s[pos] === "]") break;

    // Expect an object — anything else means malformed input, stop scanning
    if (s[pos] !== "{") break;

    const objStart = pos;
    let depth = 0;
    let inString = false;
    let escaped = false;

    while (pos < s.length) {
      const ch = s[pos]!;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\" && inString) {
        escaped = true;
      } else if (ch === '"') {
        inString = !inString;
      } else if (!inString) {
        if (ch === "{") depth += 1;
        else if (ch === "}") {
          depth -= 1;
          if (depth === 0) {
            pos += 1; // include the closing brace
            try {
              items.push(JSON.parse(s.slice(objStart, pos)));
            } catch {
              // Skip malformed object, keep scanning
            }
            break;
          }
        }
      }
      pos += 1;
    }

    // If depth !== 0 the last object was truncated — stop
    if (depth !== 0) break;
  }

  return items;
};
