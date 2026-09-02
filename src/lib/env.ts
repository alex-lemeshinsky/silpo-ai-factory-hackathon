import { z } from "zod";

function isCanonicalBase64(value: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return false;
  }
  const withoutPadding = value.replace(/=+$/, "");
  if (withoutPadding.length % 4 === 1) {
    return false;
  }
  return Buffer.from(value, "base64").toString("base64").replace(/=+$/, "") === withoutPadding;
}

const postgresUrl = z.string().min(1).superRefine((value, context) => {
  try {
    const protocol = new URL(value).protocol;
    if (protocol !== "postgres:" && protocol !== "postgresql:") {
      context.addIssue({ code: "custom", message: "must use postgres: or postgresql:" });
    }
  } catch {
    context.addIssue({ code: "custom", message: "must be an absolute Postgres URL" });
  }
});

const encryptionKey = z.string().min(1).superRefine((value, context) => {
  if (!isCanonicalBase64(value) || Buffer.from(value, "base64").byteLength !== 32) {
    context.addIssue({ code: "custom", message: "must be base64 encoding exactly 32 bytes" });
  }
});

const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: postgresUrl,
  TOKEN_ENCRYPTION_KEY: encryptionKey,
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().min(1),
  AGENT_MODEL: z.string().min(1).default("gemini-3.7-flash"),
  DATA_MODE: z.enum(["live", "demo"]).default("live"),
  PUBLIC_BASE_URL: z.string().url(),
}).strip().superRefine((value, context) => {
  const protocol = new URL(value.PUBLIC_BASE_URL).protocol;
  if (protocol !== "http:" && protocol !== "https:") {
    context.addIssue({ code: "custom", path: ["PUBLIC_BASE_URL"], message: "must use HTTP or HTTPS" });
  }
  if (value.NODE_ENV === "production" && protocol !== "https:") {
    context.addIssue({ code: "custom", path: ["PUBLIC_BASE_URL"], message: "must use HTTPS in production" });
  }
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export function getServerEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  const result = serverEnvSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid server environment: ${problems}`);
  }
  return result.data;
}
