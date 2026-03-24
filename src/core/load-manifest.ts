import { readFile } from "node:fs/promises";

import { ManifestLoadError } from "./errors.js";

type Container = Record<string, unknown> | unknown[];

function stripComment(line: string): string {
  let escaped = false;
  let quote: string | undefined;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if ((char === '"' || char === "'") && !escaped) {
      quote = quote === char ? undefined : (quote ?? char);
    }

    if (char === "#" && !quote) {
      return line.slice(0, index);
    }

    escaped = char === "\\" && !escaped;
  }

  return line;
}

function parseScalar(value: string): unknown {
  if (value === "[]") {
    return [];
  }

  if (/^-?\d+$/.test(value)) {
    return Number(value);
  }

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

export function parseSimpleYaml(source: string): unknown {
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; container: Container }> = [
    { indent: -1, container: root },
  ];

  const lines = source.split(/\r?\n/);

  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const originalLine = lines[lineNumber] ?? "";
    const withoutComment = stripComment(originalLine);
    if (withoutComment.trim().length === 0) {
      continue;
    }

    const indent = withoutComment.match(/^\s*/)?.[0].length ?? 0;
    const line = withoutComment.trim();

    while (stack.length > 1) {
      const current = stack[stack.length - 1];
      if (!current || indent > current.indent) {
        break;
      }
      stack.pop();
    }

    const parent = stack[stack.length - 1]?.container;
    if (!parent) {
      throw new ManifestLoadError(
        `Invalid YAML structure near line ${lineNumber + 1}`,
      );
    }

    if (line.startsWith("- ")) {
      if (!Array.isArray(parent)) {
        throw new ManifestLoadError(
          `List item without list parent near line ${lineNumber + 1}`,
        );
      }

      parent.push(parseScalar(line.slice(2).trim()));
      continue;
    }

    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      throw new ManifestLoadError(
        `Expected key/value pair near line ${lineNumber + 1}`,
      );
    }

    const key = line.slice(0, separatorIndex).trim();
    const remainder = line.slice(separatorIndex + 1).trim();

    if (Array.isArray(parent)) {
      throw new ManifestLoadError(
        `Unexpected mapping inside list near line ${lineNumber + 1}`,
      );
    }

    if (remainder.length > 0) {
      parent[key] = parseScalar(remainder);
      continue;
    }

    const nextLine = lines[lineNumber + 1] ?? "";
    const nextTrimmed = stripComment(nextLine).trim();
    const nextIndent = nextLine.match(/^\s*/)?.[0].length ?? 0;

    if (nextTrimmed.startsWith("- ") && nextIndent > indent) {
      const list: unknown[] = [];
      parent[key] = list;
      stack.push({ indent, container: list });
      continue;
    }

    const object: Record<string, unknown> = {};
    parent[key] = object;
    stack.push({ indent, container: object });
  }

  return root;
}

export async function loadManifestFile(path: string): Promise<unknown> {
  let raw: string;

  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unknown read error";
    throw new ManifestLoadError(
      `Could not read manifest at ${path}: ${message}`,
    );
  }

  try {
    return parseSimpleYaml(raw);
  } catch (error) {
    if (error instanceof ManifestLoadError) {
      throw error;
    }

    const message =
      error instanceof Error ? error.message : "unknown parse error";
    throw new ManifestLoadError(`Could not parse YAML in ${path}: ${message}`);
  }
}
