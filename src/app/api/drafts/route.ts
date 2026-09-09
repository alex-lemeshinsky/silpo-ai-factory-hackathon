import { createDraftsPostHandler } from "./handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/**
 * The sum of the two budgets the run already owns: 60 s of MCP work and
 * 30 s of generation. It has no local effect and is read only by a
 * serverless deployment, where a platform default would otherwise cut a
 * run below its own timeouts.
 */
export const maxDuration = 90;

export const POST = createDraftsPostHandler();
