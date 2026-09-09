import { createCartCommitPostHandler } from "./handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const POST = createCartCommitPostHandler();
