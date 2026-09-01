import type { RegistryDescriptor } from "./types";
import { classifyExactMatch, isJsonArray, isJsonObject } from "./classify";

function mavenDocs(json: Record<string, unknown>): unknown[] | null {
  const response = json["response"];
  if (!isJsonObject(response)) return null;
  const docs = response["docs"];
  if (!isJsonArray(docs)) return null;
  return docs;
}

function mavenArtifactIds(json: Record<string, unknown>): string[] {
  const docs = mavenDocs(json);
  if (!docs) return [];
  return docs.flatMap((doc) =>
    isJsonObject(doc) && typeof doc["a"] === "string" ? [doc["a"]] : [],
  );
}

/**
 * Maven Central registry descriptor (server venue). Bare-name checks search
 * by artifactId under any group ("consumer confusion" semantics) and filter
 * results to exact artifactId matches; inconclusive searches are unknown.
 */
export const MAVEN_DESCRIPTOR: RegistryDescriptor = {
  id: "maven",
  label: "Maven Central",
  language: "Java",
  venue: "server",
  classify: (input) =>
    classifyExactMatch(input, {
      candidates: mavenArtifactIds,
      total: (json) => {
        if (!mavenDocs(json)) return null;
        const response = json["response"];
        if (!isJsonObject(response)) return null;
        const numFound = response["numFound"];
        return typeof numFound === "number" ? numFound : null;
      },
      retrieved: (json) => mavenDocs(json)?.length ?? 0,
    }),
  checkOrigin: "https://search.maven.org",
  checkUrl: (name, origin = "https://search.maven.org") =>
    `${origin}/solrsearch/select?q=${encodeURIComponent(`a:${name}`)}`,
  link: (name) => `https://central.sonatype.com/search?q=${encodeURIComponent(`a:${name}`)}`,
  cacheTtl: { availableMs: 300_000, takenMs: 86_400_000 },
  rateLimitPerMinute: 30,
};
