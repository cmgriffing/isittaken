import { describe, expect, it } from "vitest";
import { VENUE_IDS, isVenueId, type VenueId } from "../src/venues.js";

describe("venue catalog", () => {
  it("exposes exactly the nine supported venue ids", () => {
    expect(VENUE_IDS).toEqual([
      "npm",
      "pypi",
      "crates",
      "rubygems",
      "nuget",
      "hex",
      "maven",
      "go",
      "packagist",
    ]);
  });

  it("is a readonly tuple typed as VenueId", () => {
    const ids: readonly VenueId[] = VENUE_IDS;
    expect(ids).toHaveLength(9);
  });

  it("isVenueId narrows known ids and rejects unknown ones", () => {
    expect(isVenueId("npm")).toBe(true);
    expect(isVenueId("pypi")).toBe(true);
    expect(isVenueId("packagist")).toBe(true);
    expect(isVenueId("go")).toBe(true);
    expect(isVenueId("cocoapods")).toBe(false);
    expect(isVenueId("")).toBe(false);
  });
});
