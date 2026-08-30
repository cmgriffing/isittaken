import type { ComposedCandidate, ProvenanceKind, SearchResponse } from "../../domain/types";

export { PROVENANCE_LABELS } from "./labels";

/** Client-side API surface. Talks only to friendly /api paths. */

export interface CreativeOk {
  status: "ok";
  cached: boolean;
  seed: string;
  candidates: ComposedCandidate[];
  generatedAtMs: number;
  quota: { burstRemaining: number; periodicRemaining: number; resetsAtMs: number };
}

export type CreativeClientResult =
  | { status: "ok"; data: CreativeOk }
  | { status: "auth-required" }
  | { status: "quota"; message: string; resetAtMs: number | null; scope: string | null }
  | { status: "failed"; message: string };

export type OrdinaryResult =
  | { status: "ok"; data: SearchResponse }
  | { status: "invalid"; message: string }
  | { status: "rate-limited"; retryAfterSeconds: number | null }
  | { status: "error" };

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ?? `Request failed with status ${response.status}.`;
  } catch {
    return `Request failed with status ${response.status}.`;
  }
}

export async function searchOrdinary(
  seed: string,
  injected?: { synonyms: string[]; creatives: string[] },
): Promise<OrdinaryResult> {
  const response = await fetch("/api/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      seed,
      injectedSynonyms: injected?.synonyms,
      injectedCreatives: injected?.creatives,
    }),
  });
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after"));
    return {
      status: "rate-limited",
      retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : null,
    };
  }
  if (!response.ok) {
    return { status: "invalid", message: await readError(response) };
  }
  return { status: "ok", data: (await response.json()) as SearchResponse };
}

export async function searchCreative(
  seed: string,
  regenerate = false,
): Promise<CreativeClientResult> {
  const response = await fetch("/api/creative-search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ seed, regenerate }),
  });
  if (response.status === 401) return { status: "auth-required" };
  if (response.status === 429) {
    const reset = response.headers.get("x-quota-reset");
    return {
      status: "quota",
      message: await readError(response),
      resetAtMs: reset ? Number(reset) : null,
      scope: response.headers.get("x-quota-scope"),
    };
  }
  if (!response.ok) {
    return { status: "failed", message: await readError(response) };
  }
  return { status: "ok", data: (await response.json()) as CreativeOk };
}

export interface SessionState {
  authenticated: boolean;
  user?: { login: string; avatarUrl: string | null };
}

export async function fetchSession(): Promise<SessionState> {
  try {
    const response = await fetch("/api/auth/session", { credentials: "same-origin" });
    if (!response.ok) return { authenticated: false };
    return (await response.json()) as SessionState;
  } catch {
    return { authenticated: false };
  }
}

export async function logout(): Promise<boolean> {
  try {
    const response = await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Merge ordinary and creative results by normalized candidate name,
 * unioning provenance and keeping the most recent registry evidence.
 */
export function mergeCandidates(groups: (ComposedCandidate[] | undefined)[]): ComposedCandidate[] {
  const byName = new Map<string, ComposedCandidate>();
  for (const group of groups) {
    if (!group) continue;
    for (const candidate of group) {
      const existing = byName.get(candidate.name);
      if (!existing) {
        byName.set(candidate.name, { ...candidate, provenance: [...candidate.provenance] });
        continue;
      }
      const provenance = new Set<ProvenanceKind>([...existing.provenance, ...candidate.provenance]);
      const registryResults = [...existing.registryResults];
      for (const result of candidate.registryResults) {
        const index = registryResults.findIndex(
          (r) => r.registry === result.registry && r.name === result.name,
        );
        const current = registryResults[index];
        if (index === -1 || !current) registryResults.push(result);
        else if (result.checkedAtMs >= current.checkedAtMs) {
          registryResults[index] = result;
        }
      }
      byName.set(candidate.name, {
        name: candidate.name,
        provenance: [...provenance],
        registryResults,
      });
    }
  }
  return [...byName.values()];
}
