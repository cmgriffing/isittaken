import type { RegistryDescriptor } from "./types";
import { classifyExactMatch, isJsonArray, isJsonObject } from "./classify";

function packagistResults(json: Record<string, unknown>): unknown[] | null {
  const results = json["results"];
  return isJsonArray(results) ? results : null;
}

function packagistNameParts(json: Record<string, unknown>): string[] {
  const results = packagistResults(json);
  if (!results) return [];
  return results.flatMap((result) => {
    if (!isJsonObject(result) || typeof result["name"] !== "string") return [];
    // Names are `vendor/package`; the bare name matches the package part.
    const namePart = result["name"].split("/")[1];
    return namePart ? [namePart] : [];
  });
}

/**
 * Packagist registry descriptor (browser venue). Packagist package pages
 * require a vendor prefix, so bare-name checks run through the search JSON
 * with exact name-part filtering; inconclusive searches are unknown.
 */
export const PACKAGIST_DESCRIPTOR: RegistryDescriptor = {
  id: "packagist",
  label: "Packagist",
  language: "PHP",
  venue: "browser",
  classify: (input) =>
    classifyExactMatch(input, {
      candidates: packagistNameParts,
      total: (json) => {
        if (!packagistResults(json)) return null;
        const total = json["total"];
        return typeof total === "number" ? total : null;
      },
      retrieved: (json) => packagistResults(json)?.length ?? 0,
    }),
  checkOrigin: "https://packagist.org",
  checkUrl: (name, origin = "https://packagist.org") =>
    `${origin}/search.json?q=${encodeURIComponent(name)}`,
  link: (name) => `https://packagist.org/?query=${encodeURIComponent(name)}`,
  cacheTtl: { availableMs: 300_000, takenMs: 86_400_000 },
};
