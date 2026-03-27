/**
 * Pre-scan CSS files to predict how many projects the language server will create.
 *
 * analyzeStylesheet() is adapted from tailwindlabs/tailwindcss-intellisense
 * (packages/tailwindcss-language-server/src/version-guesser.ts, MIT licensed).
 */

import { readFileSync } from "fs";

// ---------------------------------------------------------------------------
// analyzeStylesheet — from tailwindcss-intellisense/version-guesser.ts
// ---------------------------------------------------------------------------

type TailwindVersion = "3" | "4";

export interface TailwindStylesheet {
  root: boolean;
  versions: TailwindVersion[];
  explicitImport: boolean;
}

const HAS_V4_IMPORT = /@import\s*['"]tailwindcss(?:\/[^'"]+)?['"]/;
const HAS_V4_DIRECTIVE = /@(theme|plugin|utility|custom-variant|variant|reference)\s*[^;{]+[;{]/;
const HAS_V4_FN = /--(alpha|spacing|theme)\(/;
const HAS_LEGACY_TAILWIND = /@tailwind\s*(base|preflight|components|variants|screens)+;/;
const HAS_TAILWIND_UTILITIES = /@tailwind\s*utilities\s*[^;]*;/;
const HAS_TAILWIND = /@tailwind\s*[^;]+;/;
const HAS_COMMON_DIRECTIVE = /@(config|apply)\s*[^;{]+[;{]/;
const HAS_NON_URL_IMPORT = /@import\s*['"](?!([a-z]+:|\/\/))/;

export function analyzeStylesheet(content: string): TailwindStylesheet {
  if (HAS_V4_IMPORT.test(content)) {
    return { root: true, versions: ["4"], explicitImport: true };
  }
  if (HAS_V4_DIRECTIVE.test(content)) {
    if (HAS_TAILWIND_UTILITIES.test(content)) {
      return { root: true, versions: ["4"], explicitImport: false };
    }
    return { root: false, versions: ["4"], explicitImport: false };
  }
  if (HAS_V4_FN.test(content)) {
    return { root: false, versions: ["4"], explicitImport: false };
  }
  if (HAS_LEGACY_TAILWIND.test(content)) {
    return { root: false, versions: ["3"], explicitImport: false };
  }
  if (HAS_TAILWIND.test(content)) {
    return { root: true, versions: ["4", "3"], explicitImport: false };
  }
  if (HAS_COMMON_DIRECTIVE.test(content)) {
    return { root: false, versions: ["4", "3"], explicitImport: false };
  }
  if (HAS_NON_URL_IMPORT.test(content)) {
    return { root: true, versions: ["4", "3"], explicitImport: false };
  }
  return { root: false, versions: [], explicitImport: false };
}

// ---------------------------------------------------------------------------
// Pre-scan
// ---------------------------------------------------------------------------

export interface PrescanResult {
  /** Total CSS files found */
  totalCssFiles: number;
  /** CSS files predicted to be project roots */
  predictedRoots: number;
  /** CSS files that are Tailwind-related but not roots (could be promoted) */
  predictedNonRoots: number;
  /** CSS files with no Tailwind signals */
  predictedUnrelated: number;
  /** Upper bound on projects the server might create */
  maxProjects: number;
}

export function prescanCssFiles(files: string[]): PrescanResult {
  let predictedRoots = 0;
  let predictedNonRoots = 0;
  let predictedUnrelated = 0;

  for (const filePath of files) {
    if (!filePath.endsWith(".css")) continue;

    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const result = analyzeStylesheet(content);
    if (result.versions.length === 0) {
      predictedUnrelated++;
    } else if (result.root) {
      predictedRoots++;
    } else {
      predictedNonRoots++;
    }
  }

  const totalCssFiles = predictedRoots + predictedNonRoots + predictedUnrelated;
  return {
    totalCssFiles,
    predictedRoots,
    predictedNonRoots,
    predictedUnrelated,
    maxProjects: predictedRoots + predictedNonRoots,
  };
}
