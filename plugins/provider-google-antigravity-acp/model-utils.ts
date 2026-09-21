// Pure model parsing and resolution. No bb dependencies, so tests import it directly.

export interface RawModel {
  id: string;
  name: string;
}

export interface ModelFamily {
  id: string;
  displayName: string;
  variants: Map<string, string>;
  defaultEffort: string;
}

export interface AvailableModelReasoningEffort {
  reasoningEffort: string;
  description: string;
}

export interface AvailableModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  supportedReasoningEfforts: AvailableModelReasoningEffort[];
  defaultReasoningEffort: string;
  isDefault: boolean;
}

export interface ModelCatalog {
  families: Map<string, ModelFamily>;
  models: AvailableModel[];
  defaultFamilyId: string;
  rawModels: RawModel[];
}

export const FALLBACK_DEFAULT_MODEL_ID = "gemini-3.8-flash";
export const FALLBACK_DEFAULT_VARIANT_ID = "gemini-3.8-flash-medium";

export function normalizeModelId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

export function normalizeEffort(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-") || "medium";
}

export function prettyEffort(effort: string): string {
  return effort
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("-");
}

export function extractVersion(id: string): number[] {
  const match = id.match(/(\d+(?:\.\d+)*)/);
  if (!match) return [0];
  return match[1].split(".").map((n) => parseInt(n, 10) || 0);
}

export function compareVersions(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const va = a[i] ?? 0;
    const vb = b[i] ?? 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

export function parseRawModels(
  rawList: RawModel[],
  preferredDefaultId?: string,
  preferredFromSettings?: { model: string; effort: string } | null,
): ModelCatalog {
  const families = new Map<string, ModelFamily>();

  for (const raw of rawList) {
    const rawId = raw.id;
    const rawName = (raw.name || rawId).trim();

    const parenMatch = rawName.match(/^(.*)\s*\(([^)]+)\)\s*$/);
    let displayName: string;
    let effort: string;

    if (parenMatch) {
      displayName = parenMatch[1].trim();
      effort = normalizeEffort(parenMatch[2]);
    } else {
      displayName = rawName;
      const lastHyphen = rawId.lastIndexOf("-");
      if (lastHyphen > 0) {
        const candidate = rawId.slice(lastHyphen + 1);
        if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(candidate) && candidate.length <= 20) {
          effort = normalizeEffort(candidate);
        } else {
          effort = "medium";
        }
      } else {
        effort = "medium";
      }
    }

    const familyId = normalizeModelId(displayName);

    let fam = families.get(familyId);
    if (!fam) {
      fam = {
        id: familyId,
        displayName,
        variants: new Map(),
        defaultEffort: effort,
      };
      families.set(familyId, fam);
    }
    fam.variants.set(effort, rawId);
    if (fam.variants.size === 1) fam.defaultEffort = effort;
  }

  // Ensure default effort is medium if available, or first available variant
  for (const fam of families.values()) {
    if (fam.variants.has("medium")) {
      fam.defaultEffort = "medium";
    } else if (!fam.variants.has(fam.defaultEffort)) {
      fam.defaultEffort = fam.variants.keys().next().value! as string;
    }
  }

  let defaultFamilyId = "";
  const preferredModelId = preferredDefaultId ? normalizeModelId(preferredDefaultId) : "";
  if (preferredModelId && families.has(preferredModelId)) {
    defaultFamilyId = preferredModelId;
  }
  if (!defaultFamilyId && preferredFromSettings && families.has(preferredFromSettings.model)) {
    defaultFamilyId = preferredFromSettings.model;
  }
  if (!defaultFamilyId) {
    // 1. Fallback: Latest Flash model (highest version number containing "flash")
    const flashFamilies = [...families.keys()]
      .filter((id) => id.includes("flash"))
      .sort((a, b) => compareVersions(extractVersion(b), extractVersion(a)));

    if (flashFamilies.length > 0) {
      defaultFamilyId = flashFamilies[0];
    }
  }
  if (!defaultFamilyId) {
    // 2. Fallback: Highest version model overall
    const sortedFamilies = [...families.keys()]
      .sort((a, b) => compareVersions(extractVersion(b), extractVersion(a)));
    if (sortedFamilies.length > 0) {
      defaultFamilyId = sortedFamilies[0];
    }
  }
  if (!defaultFamilyId && families.size > 0) {
    defaultFamilyId = families.keys().next().value! as string;
  }

  const standardLadder = ["low", "medium", "high"];
  const models: AvailableModel[] = [];

  for (const fam of families.values()) {
    const efforts: string[] = [];
    for (const eff of standardLadder) if (fam.variants.has(eff)) efforts.push(eff);
    for (const eff of fam.variants.keys()) if (!efforts.includes(eff)) efforts.push(eff);

    const supportedReasoningEfforts: AvailableModelReasoningEffort[] = efforts.map((eff) => ({
      reasoningEffort: eff,
      description: `${prettyEffort(eff)} reasoning effort`,
    }));

    let defaultReasoningEffort = fam.defaultEffort;
    if (preferredFromSettings && fam.id === preferredFromSettings.model && fam.variants.has(preferredFromSettings.effort)) {
      defaultReasoningEffort = preferredFromSettings.effort;
    }

    models.push({
      id: fam.id,
      model: fam.id,
      displayName: fam.displayName,
      description: "",
      supportedReasoningEfforts,
      defaultReasoningEffort,
      isDefault: fam.id === defaultFamilyId,
    });
  }

  return { families, models, defaultFamilyId, rawModels: rawList };
}

export function resolveRawModelId(
  model: string | undefined,
  reasoningLevel: string | undefined,
  catalog: ModelCatalog,
): string {
  const families = catalog.families;
  const defFamId = catalog.defaultFamilyId;
  const rawList = catalog.rawModels;

  const cleanModel = model && model.trim() ? normalizeModelId(model) : "";
  const targetModel = cleanModel || defFamId || FALLBACK_DEFAULT_MODEL_ID;

  const rawHit = rawList.find((r) => r.id.toLowerCase() === targetModel.toLowerCase());
  if (rawHit) return rawHit.id;

  let fam: ModelFamily | undefined;
  for (const [k, v] of families.entries()) {
    if (k.toLowerCase() === targetModel.toLowerCase()) {
      fam = v;
      break;
    }
  }

  if (fam) {
    const effort = normalizeEffort(reasoningLevel ?? fam.defaultEffort ?? "medium");
    const variant = fam.variants.get(effort);
    if (variant) return variant;
    for (const [k, v] of fam.variants.entries()) {
      if (normalizeEffort(k) === effort) return v;
    }
    return fam.variants.get("medium") ?? fam.variants.values().next().value ?? targetModel;
  }

  if (
    targetModel.endsWith("-low") ||
    targetModel.endsWith("-medium") ||
    targetModel.endsWith("-high") ||
    targetModel === "gemini-pro-agent"
  ) {
    return targetModel;
  }

  if (reasoningLevel) return `${targetModel}-${normalizeEffort(reasoningLevel)}`;
  if (!cleanModel && !defFamId) return FALLBACK_DEFAULT_VARIANT_ID;
  return targetModel;
}

export function rawListsEqual(a: RawModel[], b: RawModel[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort((x, y) => x.id.localeCompare(y.id));
  const sb = [...b].sort((x, y) => x.id.localeCompare(y.id));
  for (let i = 0; i < sa.length; i++) if (sa[i].id !== sb[i].id || sa[i].name !== sb[i].name) return false;
  return true;
}
