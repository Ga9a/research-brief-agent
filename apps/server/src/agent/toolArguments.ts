export function parseToolArguments(rawArgs: string): unknown {
  const normalized = normalizeToolArguments(rawArgs);
  if (!normalized) {
    return {};
  }

  try {
    return JSON.parse(normalized);
  } catch (error) {
    const repaired = repairToolArguments(normalized);
    if (repaired) {
      return repaired;
    }

    throw error;
  }
}

export function createToolCallKey(toolName: string, args: unknown): string {
  return `${toolName}:${stableStringify(args)}`;
}

function normalizeToolArguments(rawArgs: string): string {
  return rawArgs
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function repairToolArguments(rawArgs: string): unknown | undefined {
  const firstObject = readFirstJsonObject(rawArgs);
  if (!firstObject) {
    return undefined;
  }

  const trailing = rawArgs.slice(firstObject.endIndex).trim();
  const candidates = [
    repairTrailingObjectProperties(firstObject.text, trailing),
    mergeAdjacentJsonObjects(rawArgs),
    firstObject.text
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next deterministic repair candidate.
    }
  }

  return undefined;
}

function repairTrailingObjectProperties(firstObjectText: string, trailing: string): string | undefined {
  if (!trailing.startsWith(",") || !firstObjectText.endsWith("}")) {
    return undefined;
  }

  return `${firstObjectText.slice(0, -1)}${trailing}}`;
}

function mergeAdjacentJsonObjects(rawArgs: string): string | undefined {
  const objects: unknown[] = [];
  let cursor = 0;

  while (cursor < rawArgs.length) {
    const remaining = rawArgs.slice(cursor).trimStart();
    const skipped = rawArgs.length - cursor - remaining.length;
    cursor += skipped;

    if (!remaining) {
      break;
    }

    if (!remaining.startsWith("{")) {
      return undefined;
    }

    const object = readFirstJsonObject(remaining);
    if (!object) {
      return undefined;
    }

    try {
      objects.push(JSON.parse(object.text));
    } catch {
      return undefined;
    }

    cursor += object.endIndex;
  }

  if (objects.length <= 1 || objects.some((item) => item === null || typeof item !== "object" || Array.isArray(item))) {
    return undefined;
  }

  return JSON.stringify(Object.assign({}, ...objects));
}

function readFirstJsonObject(input: string): { text: string; endIndex: number } | undefined {
  const start = input.indexOf("{");
  if (start < 0) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < input.length; index += 1) {
    const char = input[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return {
          text: input.slice(start, index + 1),
          endIndex: index + 1
        };
      }
    }
  }

  return undefined;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? String(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}
