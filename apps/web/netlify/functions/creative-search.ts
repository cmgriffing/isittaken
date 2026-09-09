import type { Config, Context } from "@netlify/functions";
import { getServerConfig } from "../../src/config/server";
import { createAppContext } from "../../src/functions/composition";
import { createCreativeSearchFunction } from "../../src/functions/creative-search";

const ctx = createAppContext(getServerConfig());
const handler = createCreativeSearchFunction(ctx);

export default async (request: Request, _context: Context) => handler(request);

export const config: Config = {
  path: "/api/creative-search",
};
