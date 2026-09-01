import type { Config, Context } from "@netlify/functions";
import { getServerConfig } from "../../src/config/server";
import { createAppContext } from "../../src/functions/composition";
import { createCheckFunction } from "../../src/functions/check";

// Composition is reused across warm invocations of the same isolate.
const ctx = createAppContext(getServerConfig());
const handler = createCheckFunction(ctx);

export default async (request: Request, _context: Context) => handler(request);

export const config: Config = {
  path: "/api/check",
};
