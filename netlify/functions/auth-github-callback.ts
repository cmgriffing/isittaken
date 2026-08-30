import type { Config, Context } from "@netlify/functions";
import { getServerConfig } from "../../src/config/server";
import { createAppContext } from "../../src/functions/composition";
import { createAuthCallbackFunction } from "../../src/functions/auth-github-callback";

const ctx = createAppContext(getServerConfig());
const handler = createAuthCallbackFunction(ctx);

export default async (request: Request, _context: Context) => handler(request);

export const config: Config = {
  path: "/api/auth/github/callback",
};
