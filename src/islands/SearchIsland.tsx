import { useEffect, useState } from "preact/hooks";
import type { ComposedCandidate, RegistryId, SearchResponse } from "../domain/types";
import { REGISTRY_LINEUP } from "../domain/registries";
import type { RegistryDescriptor } from "../domain/registries";
import type { VerdictCell } from "../lib/client/availability";
import type { SearchStore, SearchState } from "../lib/client/search-store";
import { getSearchStore } from "../lib/client/search-store";
import { fetchSession, type CreativeOk, type SessionState } from "../lib/client/api";
import { PROVENANCE_LABELS, REGISTRY_STATUS_LABELS } from "../lib/client/labels";
import GitHubSignIn from "./GitHubSignIn";

interface Props {
  initialSeed?: string;
  /** Test seam: a store instance overriding the page singleton. */
  store?: SearchStore;
}

/**
 * The interactive search experience. Ordinary discovery (seed + Wordnik +
 * OpenRouter candidates) returns names with provenance; availability across
 * the selected registries fans out progressively from the shared store's
 * service. The island is a pure view of the module-level store, so agent
 * batches land in the same grid.
 */
export default function SearchIsland({ initialSeed = "", store: storeOverride }: Props) {
  const store = storeOverride ?? getSearchStore();
  const [seed, setSeed] = useState(initialSeed);
  const [state, setState] = useState<SearchState>(() => store.getState());
  const [session, setSession] = useState<SessionState | null>(null);

  useEffect(() => store.subscribe(() => setState(store.getState())), [store]);

  // Push the initial seed into the store so agent tools share it.
  useEffect(() => {
    if (initialSeed) store.setSeed(initialSeed);
  }, [store, initialSeed]);

  // Session is only needed once results (and the creative section) exist.
  const phase = state.phase;
  useEffect(() => {
    if (phase !== "done" || session !== null) return;
    void fetchSession().then(setSession);
  }, [phase, session]);

  function toggleRegistry(id: RegistryId, enabled: boolean) {
    store.toggleRegistry(id, enabled);
  }

  async function runOrdinary(event?: Event) {
    event?.preventDefault();
    await store.runSearch(seed);
  }

  async function runCreative(regenerate: boolean) {
    await store.runCreative(regenerate);
  }

  const creativeSeed = state.creative?.status === "ok" ? state.creative.data.seed : null;
  const seedUsed = creativeSeed ?? state.ordinary?.seed ?? null;

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
          <button type="submit" disabled={state.phase === "loading"}>
            {state.phase === "loading" ? "Searching…" : "Search"}
          </button>
        </div>
        <fieldset class="registry-toggles">
          <legend>Registries to check</legend>
          {REGISTRY_LINEUP.map((descriptor) => (
            <label
              key={descriptor.id}
              class={state.agentChangedIds.includes(descriptor.id) ? "agent-touched" : undefined}
            >
              <input
                type="checkbox"
                checked={state.selectedIds.includes(descriptor.id)}
                onChange={(e) =>
                  toggleRegistry(descriptor.id, (e.target as HTMLInputElement).checked)
                }
              />
              <svg class="chip-check" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <rect class="chip-check-frame" x="1" y="1" width="14" height="14" />
                <path class="chip-check-mark" d="M6.5 11.5 3 8l1.2-1.2 2.3 2.3 4.8-4.8L13 5.5z" />
              </svg>
              {descriptor.label}
            </label>
          ))}
        </fieldset>
        {state.canRestore && (
          <p class="restore-row">
            <button type="button" class="secondary" onClick={() => store.restoreSavedSelection()}>
              Restore saved selection
            </button>
          </p>
        )}
        <p class="hint">
          crates.io, NuGet, and Packagist are checked in your browser — the rest via this site's
          API.
        </p>
      </form>

      <div aria-live="polite">
        {state.message && state.phase === "error" && (
          <p role="alert" class="error">
            {state.message}{" "}
            <button type="button" class="secondary" onClick={() => runOrdinary()}>
              Retry
            </button>
          </p>
        )}
        {state.retryAfterSeconds !== null && state.phase === "error" && (
          <p class="hint">You can retry in about {state.retryAfterSeconds} seconds.</p>
        )}
      </div>

      {state.phase === "done" && state.ordinary && (
        <Results
          seedLabel={seedUsed ?? state.ordinary.seed}
          candidates={state.candidates}
          ordinarySources={state.ordinary.sources}
          cells={state.cells}
          selectedDescriptors={state.selectedIds
            .map((id) => REGISTRY_LINEUP.find((d) => d.id === id))
            .filter((d): d is RegistryDescriptor => !!d)}
          progress={state.progress}
        />
      )}

      {state.phase === "done" && (
        <div class="creative">
          <h3>Need more? Creative names</h3>
          {session === null ? null : session.authenticated ? (
            <CreativeControls
              seedMissing={!seed.trim()}
              loading={state.creativeLoading}
              result={state.creative}
              onGenerate={() => runCreative(false)}
              onRegenerate={() => runCreative(true)}
            />
          ) : (
            <div aria-live="polite">
              <p role="status">
                Creative names are AI-generated, so they need a GitHub account to keep per-person
                quotas fair.
              </p>
              <GitHubSignIn />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function CreativeControls(props: {
  seedMissing: boolean;
  loading: boolean;
  result: SearchState["creative"];
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
          Creative generation needs an account. <GitHubSignIn />
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
  progress?: { done: number; total: number } | null;
}) {
  const { seedLabel, candidates, ordinarySources, cells, selectedDescriptors, progress } = props;
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
      {progress && (
        <p class="batch-progress" role="status">
          checking {progress.done} of {progress.total}…
        </p>
      )}
      {candidates.length === 0 && <p class="hint">No candidates yet — run a search.</p>}
      <ul class="candidates">
        {candidates.map((candidate) => {
          const cellFor = (registryId: RegistryId) => cells.get(`${candidate.name}|${registryId}`);
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
        “Available” = not found at check time — not a publishing guarantee.{" "}
        <a href="/docs/methodology">See methodology.</a>
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

export type { CreativeOk, VerdictCell };
