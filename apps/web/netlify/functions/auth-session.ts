import type { Config, Context } from "@netlify/functions";
import { getServerConfig } from "../../src/config/server";
import { createAppContext } from "../../src/functions/composition";
import { createSessionStatusFunction } from "../../src/functions/auth-session";

const ctx = createAppContext(getServerConfig());
const handler = createSessionStatusFunction(ctx);

export default async (request: Request, _context: Context) => handler(request);

export const config: Config = {
  path: "/api/auth/session",
};
