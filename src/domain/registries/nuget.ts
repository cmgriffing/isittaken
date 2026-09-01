import type { RegistryDescriptor } from "./types";
import { classifyNotFound, isJsonArray, isJsonObject } from "./classify";

function hasVersionsArray(json: unknown): boolean {
  return isJsonObject(json) && isJsonArray(json["versions"]);
}

/** NuGet registry descriptor (browser venue; the flat container serves CORS). */
export const NUGET_DESCRIPTOR: RegistryDescriptor = {
  id: "nuget",
  label: "NuGet",
  language: ".NET",
  venue: "browser",
  classify: (input) =>
    classifyNotFound(input, {
      shape: hasVersionsArray,
    }),
  checkOrigin: "https://api.nuget.org",
  checkUrl: (name, origin = "https://api.nuget.org") =>
    `${origin}/v3-flatcontainer/${encodeURIComponent(name.toLowerCase())}/index.json`,
  link: (name) => `https://www.nuget.org/packages/${encodeURIComponent(name)}`,
  cacheTtl: { availableMs: 300_000, takenMs: 86_400_000 },
};
