import { useMemo, useState } from "preact/hooks";
import type { ComposedCandidate, SearchResponse } from "../domain/types";
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

/**
 * The interactive search experience. Ordinary discovery (seed + Wordnik +
 * npm) runs independently from creative generation, so anonymous visitors
 * and provider failures never invalidate results already on screen.
 */
export default function SearchIsland({ initialSeed = "" }: Props) {
  const [seed, setSeed] = useState(initialSeed);
  const [ordinary, setOrdinary] = useState<SearchResponse | null>(null);
  const [phase, setPhase] = useState<OrdinaryPhase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [retryAfterSeconds, setRetryAfterSeconds] = useState<number | null>(null);

  const [creative, setCreative] = useState<CreativeClientResult | null>(null);
  const [creativeLoading, setCreativeLoading] = useState(false);

  const merged = useMemo<ComposedCandidate[]>(
    () =>
      mergeCandidates([
        ordinary?.candidates,
        creative?.status === "ok" ? creative.data.candidates : undefined,
      ]),
    [ordinary, creative],
  );

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
          We look up synonyms and related words, then check npm availability.
        </p>
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

export function Results(props: {
  seedLabel: string;
  candidates: ComposedCandidate[];
  ordinarySources?: SearchResponse["sources"];
}) {
  const { seedLabel, candidates, ordinarySources } = props;
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
        {candidates.map((candidate) => (
          <CandidateRow key={candidate.name} candidate={candidate} />
        ))}
      </ul>
      <p class="disclaimer">
        “Available” means npm did not know the name at the check time. It is not a publishing
        guarantee — npm can reject names or they can be taken at any moment.
      </p>
    </div>
  );
}

function CandidateRow({ candidate }: { candidate: ComposedCandidate }) {
  const npm = candidate.registryResults.find((r) => r.registry === "npm");
  const status = npm?.status ?? "unknown";
  // The slug npm actually checked (e.g. "back end" -> "back-end"); falls
  // back to the candidate name when no registry result exists yet.
  const npmSlug = npm?.name ?? candidate.name;
  const slugDiffers = npm != null && npm.name !== candidate.name;
  const checkedAt =
    npm?.checkedAtMs != null
      ? new Date(npm.checkedAtMs).toISOString().replace("T", " ").slice(0, 16) + " UTC"
      : null;
  return (
    <li class="candidate">
      <div class="candidate-head">
        <code class="name">{candidate.name}</code>
        <span class={`status-pill status-${status}`}>
          {REGISTRY_STATUS_LABELS[status] ?? status}
        </span>
      </div>
      <div class="candidate-meta">
        <span class="provenance" aria-label="Where this name came from">
          {candidate.provenance.map((kind) => (
            <span key={kind}>{PROVENANCE_LABELS[kind] ?? kind}</span>
          ))}
        </span>
        {slugDiffers && (
          <span class="hint">
            checked as <code>{npmSlug}</code> on npm
          </span>
        )}
        {status === "available" && checkedAt && <span class="hint">checked {checkedAt}</span>}
        {npm?.reason && status !== "available" && status !== "taken" && (
          <span class="hint">{npm.reason}</span>
        )}
        {status === "taken" && (
          <a
            href={`https://www.npmjs.com/package/${encodeURIComponent(npmSlug)}`}
            rel="noopener noreferrer"
            target="_blank"
          >
            view on npm
          </a>
        )}
      </div>
    </li>
  );
}

export type { CreativeOk };
