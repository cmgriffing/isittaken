/**
 * The catalog of supported registry venues. `npm` and the six definitive
 * single-name venues are exact; `maven`, `go`, and `packagist` are
 * fuzzy-capable (bare-word checks use a search index, qualified input is
 * exact).
 */
export const VENUE_IDS = [
  "npm",
  "pypi",
  "crates",
  "rubygems",
  "nuget",
  "hex",
  "maven",
  "go",
  "packagist",
] as const;

export type VenueId = (typeof VENUE_IDS)[number];

/** Narrowing guard for the venue catalog. */
export function isVenueId(value: string): value is VenueId {
  return (VENUE_IDS as readonly string[]).includes(value);
}
