import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import type { ComposedCandidate, RegistryId, SearchResponse } from "../domain/types";
import { REGISTRY_LINEUP, registryById } from "../domain/registries";
import type { RegistryDescriptor } from "../domain/registries";
import {
  createAvailabilityService,
  type AvailabilityService,
  type VerdictCell,
} from "../lib/client/availability";
import {
  mergeCandidates,
  searchCreative,
  searchOrdinary,
  type CreativeClientResult,
  type CreativeOk,
} from "../lib/client/api";
import { PROVENANCE_LABELS, REGISTRY_STATUS_LABELS } from "../lib/client/labels";

type OrdinaryPhase = "idle" | "loading" | "error" | "done";

interface Props {
  initialSeed?: string;
}

const REGISTRY_SELECTION_STORAGE_KEY = "iit_registry_selection";

function defaultSelection(): RegistryId[] {
  return REGISTRY_LINEUP.map((descriptor) => descriptor.id);
}

function loadSelection(): RegistryId[] {
  try {
    const raw = localStorage.getItem(REGISTRY_SELECTION_STORAGE_KEY);
    if (!raw) return defaultSelection();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return defaultSelection();
    // Only supported ids, lineup order preserved.
    return REGISTRY_LINEUP.filter((descriptor) => parsed.includes(descriptor.id)).map(
      (descriptor) => descriptor.id,
    );
  } catch {
    return defaultSelection();
  }
}

function saveSelection(ids: RegistryId[]): void {
  try {
    localStorage.setItem(REGISTRY_SELECTION_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Storage unavailability never breaks the search itself.
  }
}

function cellKey(candidateName: string, registryId: RegistryId): string {
  return `${candidateName}|${registryId}`;
}

/**
 * The interactive search experience. Ordinary discovery (seed + Wordnik +
 * OpenRouter candidates) returns names with provenance; availability across
 * the selected registries fans out progressively from the client.
 */
export default function SearchIsland({ initialSeed = "" }: Props) {
  const [seed, setSeed] = useState(initialSeed);
  const [ordinary, setOrdinary] = useState<SearchResponse | null>(null);
  const [phase, setPhase] = useState<OrdinaryPhase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [retryAfterSeconds, setRetryAfterSeconds] = useState<number | null>(null);

  const [creative, setCreative] = useState<CreativeClientResult | null>(null);
  const [creativeLoading, setCreativeLoading] = useState(false);

  const [selectedIds, setSelectedIds] = useState<RegistryId[]>(loadSelection);
  const [cells, setCells] = useState<Map<string, VerdictCell>>(new Map());

  const merged = useMemo<ComposedCandidate[]>(
    () =>
      mergeCandidates([
        ordinary?.candidates,
        creative?.status === "ok" ? creative.data.candidates : undefined,
      ]),
    [ordinary, creative],
  );

  const selectionKey = selectedIds.join(",");
  const selectedDescriptors = useMemo(
    () => selectedIds.map((id) => registryById(id)).filter((d): d is RegistryDescriptor => !!d),
    [selectionKey],
  );

  const applyCell = useCallback((cell: VerdictCell) => {
    setCells((previous) => {
      const next = new Map(previous);
      next.set(cellKey(cell.candidateName, cell.registry), cell);
      return next;
    });
  }, []);

  const service = useMemo<AvailabilityService | null>(() => {
    if (typeof window === "undefined") return null;
    return createAvailabilityService({ registries: selectedDescriptors, onResult: applyCell });
  }, [selectionKey, applyCell]);

  // Fan out availability checks whenever candidates or the registry
  // selection change. The service dedupes and caches; results stream in.
  useEffect(() => {
    if (!service || merged.length === 0 || selectedDescriptors.length === 0) return;
    void service.checkCandidates(merged.map((candidate) => ({ name: candidate.name })));
  }, [service, merged]);

  function toggleRegistry(id: RegistryId, enabled: boolean) {
    setSelectedIds((previous) => {
      const next = enabled
        ? REGISTRY_LINEUP.filter((d) => previous.includes(d.id) || d.id === id).map((d) => d.id)
        : previous.filter((existing) => existing !== id);
      saveSelection(next);
      return next;
    });
  }

  async function runOrdinary(event?: Event) {
    event?.preventDefault();
    const trimmed = seed.trim();
    setMessage(null);
    setRetryAfterSeconds(null);
    if (!trimmed) {
      setPhase("error");
      setMessage("Enter a seed word first.");
      return;
    }
    setPhase("loading");
    const result = await searchOrdinary(trimmed);
    if (result.status === "ok") {
      setOrdinary(result.data);
      setPhase("done");
      return;
    }
    setPhase("error");
    if (result.status === "invalid") setMessage(result.message);
    else if (result.status === "rate-limited") {
      setMessage(
        result.retryAfterSeconds
          ? `Too many searches — retry in ${result.retryAfterSeconds}s.`
          : "Too many searches — wait a moment and retry.",
      );
      setRetryAfterSeconds(result.retryAfterSeconds);
    } else setMessage("Search failed. Check your connection and retry.");
  }

  async function runCreative(regenerate: boolean) {
    if (!seed.trim()) return;
    setCreativeLoading(true);
    const result = await searchCreative(seed.trim(), regenerate);
    setCreative(result);
    setCreativeLoading(false);
  }

  const creativeSeed = creative?.status === "ok" ? creative.data.seed : null;
  const seedUsed = creativeSeed ?? ordinary?.seed ?? null;

  return (
    <section aria-labelledby="search-heading" class="search-island">
      <h2 id="search-heading">Search for package names</h2>
      <form onSubmit={runOrdinary} noValidate>
        <label htmlFor="seed">Seed word</label>
        <div class="row">
          <input
            id="seed"
            name="seed"
            type="text"
            value={seed}
            maxlength={64}
            autocomplete="off"
            required
            onInput={(e) => setSeed((e.target as HTMLInputElement).value)}
          />
          <button type="submit" disabled={phase === "loading"}>
            {phase === "loading" ? "Searching…" : "Search"}
          </button>
        </div>
        <p class="hint" id="seed-hint">
          We look up synonyms and related words, then check availability across your selected
          package registries.
        </p>

        <fieldset class="registry-toggles">
          <legend>Registries to check</legend>
          {REGISTRY_LINEUP.map((descriptor) => (
            <label key={descriptor.id}>
              <input
                type="checkbox"
                checked={selectedIds.includes(descriptor.id)}
                onChange={(e) =>
                  toggleRegistry(descriptor.id, (e.target as HTMLInputElement).checked)
                }
              />{" "}
              {descriptor.label}
              <span class="hint">
                {descriptor.venue === "server"
                  ? " · checked via API"
                  : " · checked in your browser"}
              </span>
            </label>
          ))}
        </fieldset>
      </form>

      <div aria-live="polite">
        {message && phase === "error" && (
          <p role="alert" class="error">
            {message}{" "}
            <button type="button" class="secondary" onClick={() => runOrdinary()}>
              Retry
            </button>
          </p>
        )}
        {retryAfterSeconds !== null && phase === "error" && (
          <p class="hint">You can retry in about {retryAfterSeconds} seconds.</p>
        )}
      </div>

      {phase === "done" && ordinary && (
        <Results
          seedLabel={seedUsed ?? ordinary.seed}
          candidates={merged}
          ordinarySources={ordinary.sources}
          cells={cells}
          selectedDescriptors={selectedDescriptors}
        />
      )}

      {phase === "done" && (
        <div class="creative">
          <h3>Creative names (optional, AI-powered)</h3>
          <CreativeControls
            seedMissing={!seed.trim()}
            loading={creativeLoading}
            result={creative}
            onGenerate={() => runCreative(false)}
            onRegenerate={() => runCreative(true)}
          />
        </div>
      )}
    </section>
  );
}

function CreativeControls(props: {
  seedMissing: boolean;
  loading: boolean;
  result: CreativeClientResult | null;
  onGenerate: () => void;
  onRegenerate: () => void;
}) {
  const { seedMissing, loading, result, onGenerate, onRegenerate } = props;
  return (
    <div aria-live="polite">
      <button type="button" onClick={onGenerate} disabled={loading || seedMissing}>
        {loading
          ? "Generating…"
          : result?.status === "ok"
            ? "Generate more ideas"
            : "Generate creative names"}
      </button>
      {result?.status === "ok" && result.data.cached && (
        <p class="hint">Served from cache — no quota used.</p>
      )}
      {result?.status === "ok" && !result.data.cached && (
        <p class="hint">
          Quota remaining: {result.data.quota.periodicRemaining} today ·{" "}
          {result.data.quota.burstRemaining} this minute.
        </p>
      )}
      {result?.status === "ok" && !result.data.cached && (
        <button type="button" class="secondary" onClick={onRegenerate} disabled={loading}>
          Regenerate (uses quota)
        </button>
      )}
      {result?.status === "auth-required" && (
        <p role="status">
          Creative generation needs an account.{" "}
          <a href="/api/auth/github/start" class="button">
            Sign in with GitHub
          </a>
        </p>
      )}
      {result?.status === "quota" && (
        <p role="status" class="error">
          {result.message}
        </p>
      )}
      {result?.status === "failed" && (
        <p role="status" class="error">
          {result.message}{" "}
          <button type="button" class="secondary" onClick={onGenerate}>
            Try again
          </button>
        </p>
      )}
    </div>
  );
}

function formatCheckedAt(checkedAtMs: number): string {
  return `${new Date(checkedAtMs).toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

export function Results(props: {
  seedLabel: string;
  candidates: ComposedCandidate[];
  ordinarySources?: SearchResponse["sources"];
  cells: Map<string, VerdictCell>;
  selectedDescriptors: readonly RegistryDescriptor[];
}) {
  const { seedLabel, candidates, ordinarySources, cells, selectedDescriptors } = props;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleExpanded(name: string) {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  return (
    <div class="results">
      <h3>Names for “{seedLabel}”</h3>
      {ordinarySources?.map((source) =>
        source.status !== "ok" ? (
          <p key={source.source} role="status" class="hint">
            {source.source} enrichment unavailable{source.reason ? `: ${source.reason}` : ""}. Other
            results are unaffected.
          </p>
        ) : null,
      )}
      {candidates.length === 0 && <p class="hint">No candidates yet — run a search.</p>}
      <ul class="candidates">
        {candidates.map((candidate) => {
          const cellFor = (registryId: RegistryId) =>
            cells.get(cellKey(candidate.name, registryId));
          const availableCount = selectedDescriptors.filter(
            (descriptor) => cellFor(descriptor.id)?.status === "available",
          ).length;
          const isOpen = expanded.has(candidate.name);
          return (
            <CandidateRow
              key={candidate.name}
              candidate={candidate}
              cellFor={cellFor}
              selectedDescriptors={selectedDescriptors}
              availableCount={availableCount}
              expanded={isOpen}
              onToggle={() => toggleExpanded(candidate.name)}
            />
          );
        })}
      </ul>
      <p class="disclaimer">
        “Available” means the registry did not know the name at the check time. It is not a
        publishing guarantee — registries can reject names or they can be taken at any moment.
      </p>
    </div>
  );
}

function CandidateRow(props: {
  candidate: ComposedCandidate;
  cellFor: (registryId: RegistryId) => VerdictCell | undefined;
  selectedDescriptors: readonly RegistryDescriptor[];
  availableCount: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { candidate, cellFor, selectedDescriptors, availableCount, expanded, onToggle } = props;
  const denominator = selectedDescriptors.length;
  return (
    <li class="candidate">
      <div class="candidate-head">
        <code class="name">{candidate.name}</code>
        <span
          class="ratio"
          role="status"
          aria-label={`${availableCount} of ${denominator} selected registries available`}
        >
          {availableCount}/{denominator}
        </span>
        <span class="registry-dots" aria-hidden="true">
          {selectedDescriptors.map((descriptor) => {
            const cell = cellFor(descriptor.id);
            const status = cell?.status ?? "pending";
            return (
              <span
                key={descriptor.id}
                class={`registry-dot dot-${status}`}
                title={`${descriptor.label}: ${status}`}
              />
            );
          })}
        </span>
        <button
          type="button"
          class="secondary expand-toggle"
          aria-expanded={expanded}
          aria-controls={`details-${candidate.name}`}
          onClick={onToggle}
        >
          {expanded ? "Hide details" : "Details"}
        </button>
      </div>
      <div class="candidate-meta">
        <span class="provenance" aria-label="Where this name came from">
          {candidate.provenance.map((kind) => (
            <span key={kind}>{PROVENANCE_LABELS[kind] ?? kind}</span>
          ))}
        </span>
        {selectedDescriptors.some((descriptor) => cellFor(descriptor.id)?.cached) && (
          <span class="cached-chip">cached</span>
        )}
      </div>
      {expanded && (
        <ul class="registry-results" id={`details-${candidate.name}`}>
          {selectedDescriptors.map((descriptor) => (
            <RegistryResultItem
              key={descriptor.id}
              descriptor={descriptor}
              candidateName={candidate.name}
              cell={cellFor(descriptor.id)}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function RegistryResultItem(props: {
  descriptor: RegistryDescriptor;
  candidateName: string;
  cell?: VerdictCell;
}) {
  const { descriptor, candidateName, cell } = props;
  const status = cell?.status ?? "pending";
  const checkedName = cell?.checkedName ?? candidateName;
  const checkedAsDiffers = cell != null && cell.checkedName !== candidateName;
  return (
    <li class="registry-result">
      <span class="registry-label">{descriptor.label}</span>
      <span class={`status-pill status-${status}`}>
        {status === "pending" ? "checking…" : (REGISTRY_STATUS_LABELS[status] ?? status)}
      </span>
      {cell?.cached && <span class="cached-chip">cached</span>}
      {checkedAsDiffers && (
        <span class="hint">
          checked as <code>{checkedName}</code>
        </span>
      )}
      {cell?.checkedAtMs != null && status !== "pending" && (
        <span class="hint">checked {formatCheckedAt(cell.checkedAtMs)}</span>
      )}
      {cell?.reason && status !== "available" && status !== "taken" && (
        <span class="hint">{cell.reason}</span>
      )}
      {status !== "pending" && (
        <a href={descriptor.link(checkedName)} rel="noopener noreferrer" target="_blank">
          view on {descriptor.label}
        </a>
      )}
    </li>
  );
}

export type { CreativeOk };
