import type { PackageRegistry, RegistryLookupResult, RegistryValidation } from "@isittaken/core";

export interface FakeRegistrySpec {
  id: string;
  validate?: (value: string) => RegistryValidation;
  /** Scripted results by lookup name; unknown names throw. */
  results: Record<string, RegistryLookupResult>;
  /** Fallback for any name not in `results` (takes precedence over throwing). */
  defaultResult?: RegistryLookupResult;
}

export function fakeRegistry(spec: FakeRegistrySpec): PackageRegistry {
  return {
    id: spec.id,
    validate:
      spec.validate ?? ((value) => ({ ok: true, name: value.toLowerCase().replace(/\s+/g, "-") })),
    async lookup(name) {
      const scripted = spec.results[name];
      if (scripted) return scripted;
      if (spec.defaultResult) return spec.defaultResult;
      throw new Error(`unexpected lookup: ${name}`);
    },
  };
}

export function availableAt(checkedAtMs: number): RegistryLookupResult {
  return { status: "available", checkedAtMs };
}

export function takenAt(checkedAtMs: number): RegistryLookupResult {
  return { status: "taken", checkedAtMs };
}

export function unknownAt(checkedAtMs: number, reason: string): RegistryLookupResult {
  return { status: "unknown", checkedAtMs, reason };
}

/** npm-style validation: collapses spaces to hyphens, rejects scoped names. */
export function npmValidate(value: string): RegistryValidation {
  const collapsed = value.toLowerCase().replace(/\s+/g, "-");
  if (collapsed.includes("/")) return { ok: false, reason: "Scoped npm names are not supported." };
  if (collapsed.length === 0) return { ok: false, reason: "Name is empty." };
  return { ok: true, name: collapsed };
}

/** pypi-style validation: PEP 503 normalization. */
export function pypiValidate(value: string): RegistryValidation {
  const normalized = value.toLowerCase().replace(/[-_.]+/g, "-");
  if (normalized.startsWith("-") || normalized.endsWith("-")) {
    return { ok: false, reason: "Name cannot start or end with a hyphen." };
  }
  return { ok: true, name: normalized };
}

export function captureOut(): { lines: string[]; out: (line: string) => void } {
  const lines: string[] = [];
  return { lines, out: (line) => lines.push(line) };
}
