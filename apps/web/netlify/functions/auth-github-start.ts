import type { Config, Context } from "@netlify/functions";
import { getServerConfig } from "../../src/config/server";
import { createAppContext } from "../../src/functions/composition";
import { createAuthStartFunction } from "../../src/functions/auth-github-start";

const ctx = createAppContext(getServerConfig());
const handler = createAuthStartFunction(ctx);

export default async (request: Request, _context: Context) => handler(request);

export const config: Config = {
  path: "/api/auth/github/start",
};
