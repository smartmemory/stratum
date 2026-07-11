/**
 * Canonical JSON shared with Python's `json.dumps(..., sort_keys=True,
 * separators=(",", ":"))` for guard checksums and ledger digests.
 *
 * Guard payloads deliberately admit only JSON's primitive values and safe
 * JavaScript integers. Rejecting unsupported values is safer than hashing a
 * representation that Python cannot reproduce.
 */

function unicodeEscape(codeUnit: number): string {
  return `\\u${codeUnit.toString(16).padStart(4, "0")}`;
}

function quoteString(value: string): string {
  let encoded = '"';
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    switch (codeUnit) {
      case 0x08: encoded += "\\b"; break;
      case 0x09: encoded += "\\t"; break;
      case 0x0a: encoded += "\\n"; break;
      case 0x0c: encoded += "\\f"; break;
      case 0x0d: encoded += "\\r"; break;
      case 0x22: encoded += "\\\""; break;
      case 0x5c: encoded += "\\\\"; break;
      default:
        // Python's ensure_ascii=True escapes DEL too, as well as all
        // non-ASCII UTF-16 units. Escaping code units intentionally produces
        // the two lowercase surrogate escapes required for astral characters.
        encoded += codeUnit < 0x20 || codeUnit >= 0x7f
          ? unicodeEscape(codeUnit)
          : String.fromCharCode(codeUnit);
    }
  }
  return `${encoded}"`;
}

/** Match Python's Unicode-code-point ordering rather than JS UTF-16 ordering. */
function comparePythonStrings(left: string, right: string): number {
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftCodePoint = left.codePointAt(leftIndex);
    const rightCodePoint = right.codePointAt(rightIndex);
    if (leftCodePoint === undefined || rightCodePoint === undefined) break;
    if (leftCodePoint !== rightCodePoint) return leftCodePoint - rightCodePoint;
    leftIndex += leftCodePoint > 0xffff ? 2 : 1;
    rightIndex += rightCodePoint > 0xffff ? 2 : 1;
  }
  return left.length - leftIndex - (right.length - rightIndex);
}

function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function encode(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string") return quoteString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError("canonicalJson only accepts safe integer numbers");
    }
    return String(value);
  }
  if (typeof value !== "object") {
    throw new TypeError(`canonicalJson cannot serialize ${typeof value}`);
  }
  if (ancestors.has(value)) throw new TypeError("canonicalJson cannot serialize cyclic values");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const values: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new TypeError("canonicalJson cannot serialize sparse arrays");
        values.push(encode(value[index], ancestors));
      }
      return `[${values.join(",")}]`;
    }

    if (!isPlainRecord(value)) throw new TypeError("canonicalJson only accepts plain objects and arrays");
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError("canonicalJson cannot serialize symbol-keyed properties");
    }
    return `{${Object.keys(value)
      .sort(comparePythonStrings)
      .map((key) => `${quoteString(key)}:${encode(value[key], ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** Return Python-compatible canonical JSON or throw before hashing invalid data. */
export function canonicalJson(value: unknown): string {
  return encode(value, new Set<object>());
}
