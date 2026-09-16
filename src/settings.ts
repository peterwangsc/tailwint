import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

type Settings = Record<string, any>;

/** VS Code settings are JSONC. Strings may themselves contain comment syntax. */
export function readSettings(root: string): Settings {
  const path = resolve(root, ".vscode/settings.json");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const errors: ParseError[] = [];
  const parsed = parse(text.replace(/^\uFEFF/, ""), errors, {
    allowTrailingComma: true, allowEmptyContent: true,
  });
  const settings = parsed === undefined ? {} : parsed;
  if (errors.length || settings === null || typeof settings !== "object" || Array.isArray(settings)) {
    const detail = errors.length ? printParseErrorCode(errors[0].error) : "expected an object";
    throw new Error(`Invalid ${path}: ${detail}`);
  }
  return settings;
}

/** Expand VS Code's dotted keys without traversing inherited object properties. */
export function getSettingsSection(settings: Settings, section?: string): any {
  const result: Settings = Object.create(null);
  for (const [key, value] of Object.entries(settings)) {
    const path = key.split(".");
    let target = result;
    for (const part of path.slice(0, -1)) {
      if (!Object.hasOwn(target, part) || target[part] === null
        || typeof target[part] !== "object" || Array.isArray(target[part])) {
        target[part] = Object.create(null);
      }
      target = target[part];
    }
    // Parsed objects must also have no inherited properties when traversed later.
    target[path[path.length - 1]] = cloneSetting(value);
  }
  let value: any = result;
  for (const part of section?.split(".") ?? []) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, part)) return null;
    value = value[part];
  }
  return value;
}

function cloneSetting(value: any): any {
  if (Array.isArray(value)) return value.map(cloneSetting);
  if (value === null || typeof value !== "object") return value;
  return Object.assign(Object.create(null), Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, cloneSetting(item)]),
  ));
}
