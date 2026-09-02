# Tasks 1–2 Project Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the reproducible Next.js/test foundation and freeze the validated shared contracts that all later Inventory Autopilot tasks consume.

**Architecture:** Task 1 creates one strict App Router workspace with a minimal server-rendered landing page and fast evidence-producing tooling. Task 2 adds framework-independent Zod domain schemas, a provider-neutral `SilpoGateway`, typed results, and the only server-environment parser. The tasks are sequential and end in separate commits because Task 2 consumes Task 1's harness and becomes the contract freeze point.

**Tech Stack:** pnpm, Next.js App Router, React, TypeScript, Tailwind CSS/PostCSS, Zod, Vitest, jsdom, Testing Library, Playwright, ESLint.

**Spec:** [`docs/superpowers/specs/2026-09-02-project-foundation-design.md`](../specs/2026-09-02-project-foundation-design.md)

## Global Constraints

- Use `pnpm` exclusively; do not create npm or Yarn lockfiles.
- Keep the repository as one private workspace package.
- Runtime dependencies for this plan are only `next`, `react`, `react-dom`, and `zod`.
- Do not install Drizzle, AI SDK, MCP, database, or UI-component packages.
- `src/features/shared/contracts.ts` must not import React, Next.js, MCP SDK, AI SDK, a database client, or `src/lib/env.ts`.
- No application module reads `process.env` except `src/lib/env.ts`.
- Runtime schemas are the source of truth for serializable domain types; infer TypeScript types with `z.infer` where practical.
- External-boundary objects use strict Zod schemas, finite numbers, non-empty IDs, and no guessed alternate shapes.
- `getServerEnv(source = process.env)` is the only runtime export from `src/lib/env.ts`; `ServerEnv` is type-only.
- Required environment keys are `DATABASE_URL`, `TOKEN_ENCRYPTION_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, and `PUBLIC_BASE_URL`; `AGENT_MODEL` defaults to `gemini-3.7-flash` and `DATA_MODE` defaults to `live`.
- `SetCartProductsInput.addQuantity` is the literal `false`.
- Checkout links are invalid unless cart status is `verified` and no error-level validation exists.
- Preserve the existing untracked `SILPO_MCP.md`; do not stage or edit it.
- Follow red-green-refactor and keep exactly one focused commit per backlog task.

## File Structure

```text
.gitignore                           generated/secret artifact policy
package.json                        scripts and direct dependencies
pnpm-lock.yaml                      reproducible dependency graph
pnpm-workspace.yaml                 single-package workspace declaration
tsconfig.json                       strict TypeScript and @/* alias
next.config.ts                      typed minimal Next.js configuration
eslint.config.mjs                   Next Core Web Vitals + TypeScript linting
postcss.config.mjs                  Tailwind PostCSS plugin
vitest.config.ts                    jsdom, React transform, alias, setup
vitest.setup.ts                     jest-dom matcher registration
playwright.config.ts                browser-test location and local server
src/app/layout.tsx                  root metadata, language, CSS import
src/app/page.tsx                    minimal accessible landing page
src/app/globals.css                 Tailwind entry and base canvas
src/app/page.test.tsx               landing-page behavior test
src/features/shared/contracts.ts    domain schemas, types, and SilpoGateway
src/features/shared/contracts.test.ts contract invariants and result helpers
src/lib/result.ts                   Result/AppError types and constructors
src/lib/env.ts                      sole server environment parser
src/lib/env.test.ts                 environment validation and redaction tests
```

---

### Task 1: Project shell and test harness

**Files:**
- Create: `.gitignore`
- Create: `package.json`
- Create: `pnpm-lock.yaml` through `pnpm add`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.json`
- Create: `next.config.ts`
- Create: `eslint.config.mjs`
- Create: `postcss.config.mjs`
- Create: `vitest.config.ts`
- Create: `vitest.setup.ts`
- Create: `playwright.config.ts`
- Create: `src/app/page.test.tsx`
- Create after the red test: `src/app/layout.tsx`
- Create after the red test: `src/app/page.tsx`
- Create after the red test: `src/app/globals.css`

**Interfaces:**
- Consumes: none.
- Produces: `pnpm dev`, `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:watch`, and `pnpm test:e2e`; `@/* -> src/*`; a jsdom/Testing Library harness; an App Router root page.

- [ ] **Step 1: Reconfirm the clean implementation boundary**

Run:

```bash
git status --short
```

Expected: documentation changes from planning are committed before implementation; `SILPO_MCP.md` is the only unrelated untracked path. Do not stage it.

- [ ] **Step 2: Create repository/package metadata**

Create `.gitignore`:

```gitignore
# dependencies
/node_modules
/.pnp
.pnp.*

# Next.js
/.next/
/out/

# tests
/coverage/
/playwright-report/
/test-results/

# local environment; Task 18 owns the safe template
.env*
!.env.example

# TypeScript and package-manager output
*.tsbuildinfo
next-env.d.ts
pnpm-debug.log*

# OS/editor noise
.DS_Store
```

Create `package.json`:

```json
{
  "name": "inventory-autopilot",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test"
  }
}
```

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - "."
```

- [ ] **Step 3: Install only Task 1 dependencies and generate the lockfile**

Run:

```bash
pnpm add next react react-dom zod
pnpm add -D typescript @types/node @types/react @types/react-dom eslint eslint-config-next tailwindcss @tailwindcss/postcss postcss vitest jsdom @vitejs/plugin-react @testing-library/dom @testing-library/react @testing-library/jest-dom @playwright/test
```

Expected: both commands exit zero, `package.json` contains the direct dependencies, and `pnpm-lock.yaml` is created. Do not run `pnpm exec playwright install`; Task 1 has no browser test.

- [ ] **Step 4: Configure TypeScript and Next.js**

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2017",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": {
      "@/*": ["./src/*"]
    },
    "types": ["vitest/globals", "@testing-library/jest-dom"]
  },
  "include": [
    "next-env.d.ts",
    "**/*.ts",
    "**/*.tsx",
    ".next/types/**/*.ts",
    ".next/dev/types/**/*.ts"
  ],
  "exclude": ["node_modules"]
}
```

Create `next.config.ts`:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {};

export default nextConfig;
```

- [ ] **Step 5: Configure lint and CSS processing**

Create `eslint.config.mjs`:

```js
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    "next-env.d.ts",
  ]),
]);
```

Create `postcss.config.mjs`:

```js
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
```

- [ ] **Step 6: Configure unit/component and browser test runners**

Create `vitest.config.ts`:

```ts
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    restoreMocks: true,
    setupFiles: ["./vitest.setup.ts"],
  },
});
```

Create `vitest.setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
```

Create `playwright.config.ts`:

```ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: "html",
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "pnpm dev",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: true,
  },
});
```

- [ ] **Step 7: Write the failing landing-page test**

Create `src/app/page.test.tsx` before `src/app/page.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import HomePage from "./page";

it("introduces Inventory Autopilot", () => {
  render(<HomePage />);

  expect(
    screen.getByRole("heading", { level: 1, name: "Автопілот запасів" }),
  ).toBeVisible();
});
```

- [ ] **Step 8: Run the focused test and prove red**

Run:

```bash
pnpm vitest run src/app/page.test.tsx
```

Expected: FAIL because `./page` does not exist. A configuration, dependency, or matcher failure is not the expected red; correct the harness until the missing page is the failure.

- [ ] **Step 9: Implement the minimum App Router shell**

Create `src/app/layout.tsx`:

```tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Автопілот запасів",
  description: "Персональна чернетка регулярних покупок",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="uk">
      <body>{children}</body>
    </html>
  );
}
```

Create `src/app/page.tsx`:

```tsx
export default function HomePage() {
  return (
    <main>
      <h1>Автопілот запасів</h1>
    </main>
  );
}
```

Create `src/app/globals.css`:

```css
@import "tailwindcss";

*,
*::before,
*::after {
  box-sizing: border-box;
}

:root {
  color: #202124;
  background: #ffffff;
  font-family: Inter, ui-rounded, "SF Pro Rounded", "Segoe UI", sans-serif;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
}

html,
body {
  min-height: 100%;
}

body {
  margin: 0;
}

main {
  display: grid;
  min-height: 100vh;
  place-items: center;
  padding: 1rem;
}

h1 {
  margin: 0;
  font-size: clamp(2rem, 8vw, 3rem);
  line-height: 1.12;
}
```

- [ ] **Step 10: Run the focused test and prove green**

Run:

```bash
pnpm vitest run src/app/page.test.tsx
```

Expected: PASS with one test.

- [ ] **Step 11: Run Task 1 cumulative gates**

Run each command separately so the failing gate is obvious:

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

Expected: every command exits zero. `pnpm test:e2e` is intentionally deferred because `tests/e2e` does not exist yet and Task 1 has no browser acceptance flow.

- [ ] **Step 12: Review scope and commit Task 1**

Run:

```bash
git diff --check
git status --short
git diff -- . ':(exclude)SILPO_MCP.md'
```

Confirm there are no secrets, generated artifacts, extra dependencies, or unrelated files. Then commit only Task 1:

```bash
git add .gitignore package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json next.config.ts eslint.config.mjs postcss.config.mjs vitest.config.ts vitest.setup.ts playwright.config.ts src/app
git commit -m "chore: scaffold inventory autopilot app"
```

Expected: one focused commit; `SILPO_MCP.md` remains untracked.

---

### Task 2: Shared domain contracts and environment validation

**Files:**
- Create: `src/features/shared/contracts.test.ts`
- Create: `src/lib/env.test.ts`
- Create after the red tests: `src/features/shared/contracts.ts`
- Create after the red tests: `src/lib/result.ts`
- Create after the red tests: `src/lib/env.ts`

**Interfaces:**
- Consumes: Task 1's Vitest/jsdom harness and `@/*` alias.
- Produces: validated `DataMode`, purchase, prediction, product, customer, cart-context, draft, and verified-cart schemas/types; `SilpoGateway`; `Result<T,E>`, `AppError`, `ok`, `err`; `getServerEnv(source?)` and the type-only `ServerEnv`.

- [ ] **Step 1: Confirm Task 1 is integrated and green**

Run:

```bash
git log -1 --oneline
pnpm vitest run src/app/page.test.tsx
pnpm typecheck
```

Expected: HEAD is the Task 1 commit, the focused page test passes, and typecheck exits zero. If not, stop and integrate/fix Task 1 instead of recreating its harness.

- [ ] **Step 2: Write the failing shared-contract tests**

Create `src/features/shared/contracts.test.ts`:

```ts
import {
  DraftSchema,
  NeedCandidateSchema,
  ProductCandidateSchema,
  RawPurchaseReceiptSchema,
  SetCartProductsInputSchema,
  VerifiedCartSchema,
} from "@/features/shared/contracts";
import { err, ok } from "@/lib/result";

const need = {
  categoryKey: "water",
  confidence: 0.8,
  confidenceBand: "high" as const,
  typicalQuantity: 2,
  reasonCodes: ["cycle_due"],
  preferredExternalProductIds: [101],
  features: {
    weightedPurchaseCount: 4,
    medianIntervalDays: 7,
    intervalMadDays: 1,
    daysSinceLastPurchase: 8,
    activeCityShare: 1,
    repeatScore: 0.8,
    dueScore: 0.9,
    stabilityScore: 0.7,
  },
};

const product = {
  productId: "water-1",
  externalProductId: 101,
  slug: "water-1",
  name: "Вода негазована",
  imageUrl: null,
  price: 20,
  specialPrice: null,
  available: true,
  stock: 10,
  step: 1,
  displayRatio: 1,
  nutritionStatus: "insufficient" as const,
  nutrition: null,
  promotions: [],
};

const draft = {
  id: "draft-1",
  mode: "demo" as const,
  status: "ready" as const,
  algorithmVersion: "prediction-v1",
  trainingCutoff: "2026-09-02T00:00:00.000Z",
  summary: "Схоже, вода скоро закінчиться",
  items: [
    {
      productId: product.productId,
      externalProductId: product.externalProductId,
      name: product.name,
      quantity: 2,
      price: product.price,
      stock: product.stock,
      step: product.step,
      confidence: need.confidence,
      confidenceBand: need.confidenceBand,
      reasonCodes: need.reasonCodes,
      reason: "Купуєте приблизно раз на 7 днів",
      nutritionStatus: product.nutritionStatus,
      alternatives: [],
    },
  ],
  total: 40,
  version: 1,
};

it("accepts representative purchase, need, product, and draft values", () => {
  expect(
    RawPurchaseReceiptSchema.parse({
      sourceId: "receipt-1",
      channel: "offline",
      purchasedAt: "2026-08-25T10:00:00.000Z",
      city: "Київ",
      total: 40,
      items: [
        {
          sourceId: "item-1",
          externalProductId: 101,
          productId: "water-1",
          name: "Вода негазована",
          quantity: 2,
          unit: "шт",
          unitPrice: 20,
        },
      ],
    }),
  ).toBeDefined();
  expect(NeedCandidateSchema.parse(need)).toEqual(need);
  expect(ProductCandidateSchema.parse(product)).toEqual(product);
  expect(DraftSchema.parse(draft)).toEqual(draft);
});

it("rejects a draft item without a source product id", () => {
  const invalid = structuredClone(draft);
  invalid.items[0]!.productId = "";

  expect(() => DraftSchema.parse(invalid)).toThrow();
});

it("rejects confidence that disagrees with its band", () => {
  expect(() =>
    NeedCandidateSchema.parse({ ...need, confidence: 0.7, confidenceBand: "high" }),
  ).toThrow();
});

it("rejects draft quantity that is not aligned to the product step", () => {
  const invalid = structuredClone(draft);
  invalid.items[0]!.quantity = 1.5;
  invalid.total = 30;

  expect(() => DraftSchema.parse(invalid)).toThrow();
});

it("requires absolute rather than additive cart quantities", () => {
  expect(
    SetCartProductsInputSchema.parse({
      cartId: "cart-1",
      items: [{ productId: "water-1", quantity: 2 }],
      addQuantity: false,
    }).addQuantity,
  ).toBe(false);
  expect(() =>
    SetCartProductsInputSchema.parse({
      cartId: "cart-1",
      items: [{ productId: "water-1", quantity: 2 }],
      addQuantity: true,
    }),
  ).toThrow();
});

it("blocks checkout links when the cart has an error validation", () => {
  expect(() =>
    VerifiedCartSchema.parse({
      cartId: "cart-1",
      status: "verified",
      items: [{ productId: "water-1", quantity: 2, unitPrice: 20, available: true }],
      total: 40,
      validations: [
        { severity: "error", code: "slot_expired", message: "Оберіть слот", productId: null },
      ],
      checkoutLinks: { web: "https://example.test/cart", mobile: "https://example.test/app/cart" },
    }),
  ).toThrow();
});

it("accepts checkout links only for a verified cart without errors", () => {
  expect(
    VerifiedCartSchema.parse({
      cartId: "cart-1",
      status: "verified",
      items: [{ productId: "water-1", quantity: 2, unitPrice: 20, available: true }],
      total: 40,
      validations: [{ severity: "warning", code: "price_note", message: "Ціну перевірено", productId: "water-1" }],
      checkoutLinks: { web: "https://example.test/cart", mobile: "https://example.test/app/cart" },
    }).status,
  ).toBe("verified");
});

it("constructs typed success and failure results", () => {
  expect(ok(42)).toEqual({ ok: true, value: 42 });
  expect(
    err({
      code: "unexpected",
      message: "Безпечне повідомлення",
      correlationId: "correlation-1",
      retryAfterMs: null,
    }),
  ).toEqual({
    ok: false,
    error: {
      code: "unexpected",
      message: "Безпечне повідомлення",
      correlationId: "correlation-1",
      retryAfterMs: null,
    },
  });
});
```

- [ ] **Step 3: Write the failing environment tests**

Create `src/lib/env.test.ts`:

```ts
import { getServerEnv } from "@/lib/env";

function validEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    DATABASE_URL: "postgres://inventory.test/database",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    GOOGLE_GENERATIVE_AI_API_KEY: "synthetic-google-key",
    AGENT_MODEL: "gemini-3.7-flash",
    DATA_MODE: "demo",
    PUBLIC_BASE_URL: "https://inventory.test",
    ...overrides,
  };
}

it("parses valid synthetic server configuration", () => {
  expect(getServerEnv(validEnv())).toMatchObject({
    NODE_ENV: "test",
    AGENT_MODEL: "gemini-3.7-flash",
    DATA_MODE: "demo",
    PUBLIC_BASE_URL: "https://inventory.test",
  });
});

it("applies safe defaults", () => {
  const source = validEnv();
  delete source.NODE_ENV;
  delete source.AGENT_MODEL;
  delete source.DATA_MODE;

  expect(getServerEnv(source)).toMatchObject({
    NODE_ENV: "development",
    AGENT_MODEL: "gemini-3.7-flash",
    DATA_MODE: "live",
  });
});

it("requires the Gemini key", () => {
  const source = validEnv();
  delete source.GOOGLE_GENERATIVE_AI_API_KEY;

  expect(() => getServerEnv(source)).toThrow(/GOOGLE_GENERATIVE_AI_API_KEY/);
});

it("requires the public base URL", () => {
  const source = validEnv();
  delete source.PUBLIC_BASE_URL;

  expect(() => getServerEnv(source)).toThrow(/PUBLIC_BASE_URL/);
});

it("rejects invalid data mode", () => {
  expect(() => getServerEnv(validEnv({ DATA_MODE: "automatic" }))).toThrow(/DATA_MODE/);
});

it("requires a 32-byte decoded encryption key", () => {
  expect(() =>
    getServerEnv(validEnv({ TOKEN_ENCRYPTION_KEY: Buffer.alloc(31).toString("base64") })),
  ).toThrow(/TOKEN_ENCRYPTION_KEY/);
});

it("requires a Postgres database URL", () => {
  expect(() => getServerEnv(validEnv({ DATABASE_URL: "https://database.test" }))).toThrow(
    /DATABASE_URL/,
  );
});

it("requires HTTPS for the production public URL", () => {
  expect(() =>
    getServerEnv(validEnv({ NODE_ENV: "production", PUBLIC_BASE_URL: "http://inventory.test" })),
  ).toThrow(/PUBLIC_BASE_URL/);
});

it("does not echo a supplied secret in validation errors", () => {
  const suppliedSecret = "not-valid-base64-secret";
  let thrown: unknown;

  try {
    getServerEnv(validEnv({ TOKEN_ENCRYPTION_KEY: suppliedSecret }));
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).not.toContain(suppliedSecret);
});
```

- [ ] **Step 4: Run Task 2 tests and prove red**

Run:

```bash
pnpm vitest run src/features/shared/contracts.test.ts src/lib/env.test.ts
```

Expected: FAIL because `@/features/shared/contracts`, `@/lib/result`, and `@/lib/env` do not exist. Fix only test syntax/harness errors; keep the missing production modules as the red cause.

- [ ] **Step 5: Implement typed application results**

Create `src/lib/result.ts`:

```ts
export type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export type AppErrorCode =
  | "unauthorized"
  | "rate_limited"
  | "needs_slot"
  | "invalid_external_data"
  | "unavailable_product"
  | "cart_validation_error"
  | "partial_commit"
  | "model_invalid_output"
  | "unexpected";

export interface AppError {
  code: AppErrorCode;
  message: string;
  correlationId: string;
  retryAfterMs: number | null;
}

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
```

- [ ] **Step 6: Implement shared schema helpers and purchase/prediction contracts**

Create `src/features/shared/contracts.ts` with this first section:

```ts
import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);
const isoDateTime = z.string().datetime({ offset: true });
const finiteNonNegative = z.number().finite().nonnegative();
const finitePositive = z.number().finite().positive();
const unique = <T>(values: T[]) => new Set(values).size === values.length;
const stepAligned = (quantity: number, step: number) =>
  Math.abs(quantity / step - Math.round(quantity / step)) <= 1e-9;

export const DataModeSchema = z.enum(["live", "demo"]);
export type DataMode = z.infer<typeof DataModeSchema>;
export const PurchaseChannelSchema = z.enum(["offline", "online"]);
export type PurchaseChannel = z.infer<typeof PurchaseChannelSchema>;
export const ConfidenceBandSchema = z.enum(["medium", "high"]);
export type ConfidenceBand = z.infer<typeof ConfidenceBandSchema>;
export const NutritionStatusSchema = z.enum(["known", "insufficient"]);
export type NutritionStatus = z.infer<typeof NutritionStatusSchema>;
export const DraftStatusSchema = z.enum([
  "syncing",
  "generating",
  "ready",
  "confirming",
  "partially_committed",
  "verified",
  "blocked",
]);
export type DraftStatus = z.infer<typeof DraftStatusSchema>;
export const ValidationSeveritySchema = z.enum(["warning", "error"]);
export type ValidationSeverity = z.infer<typeof ValidationSeveritySchema>;

export const RawPurchaseItemSchema = z.object({
  sourceId: nonEmptyString,
  externalProductId: z.number().int().nonnegative().nullable(),
  productId: nonEmptyString.nullable(),
  name: nonEmptyString,
  quantity: finitePositive,
  unit: nonEmptyString.nullable(),
  unitPrice: finiteNonNegative,
}).strict();
export type RawPurchaseItem = z.infer<typeof RawPurchaseItemSchema>;

export const RawPurchaseReceiptSchema = z.object({
  sourceId: nonEmptyString,
  channel: PurchaseChannelSchema,
  purchasedAt: isoDateTime,
  city: nonEmptyString.nullable(),
  total: finiteNonNegative,
  items: z.array(RawPurchaseItemSchema).min(1),
}).strict();
export type RawPurchaseReceipt = z.infer<typeof RawPurchaseReceiptSchema>;

export const NormalizedPurchaseItemSchema = RawPurchaseItemSchema.extend({
  normalizedName: nonEmptyString,
  categoryKey: nonEmptyString,
}).strict();
export type NormalizedPurchaseItem = z.infer<typeof NormalizedPurchaseItemSchema>;

export const NormalizedReceiptSchema = z.object({
  sourceIds: z.array(nonEmptyString).min(1).refine(unique, "sourceIds must be unique"),
  channel: PurchaseChannelSchema,
  purchasedAt: isoDateTime,
  city: nonEmptyString.nullable(),
  total: finiteNonNegative,
  externalFingerprint: nonEmptyString,
  items: z.array(NormalizedPurchaseItemSchema).min(1),
}).strict();
export type NormalizedReceipt = z.infer<typeof NormalizedReceiptSchema>;

export const NeedFeaturesSchema = z.object({
  weightedPurchaseCount: finiteNonNegative,
  medianIntervalDays: finiteNonNegative,
  intervalMadDays: finiteNonNegative,
  daysSinceLastPurchase: finiteNonNegative,
  activeCityShare: z.number().finite().min(0).max(1),
  repeatScore: z.number().finite().min(0).max(1),
  dueScore: z.number().finite().min(0).max(1),
  stabilityScore: z.number().finite().min(0).max(1),
}).strict();
export type NeedFeatures = z.infer<typeof NeedFeaturesSchema>;

export const NeedCandidateSchema = z.object({
  categoryKey: nonEmptyString,
  confidence: z.number().finite().min(0.55).max(1),
  confidenceBand: ConfidenceBandSchema,
  typicalQuantity: finitePositive,
  reasonCodes: z.array(nonEmptyString).min(1).refine(unique, "reasonCodes must be unique"),
  preferredExternalProductIds: z.array(z.number().int().nonnegative())
    .refine(unique, "preferredExternalProductIds must be unique"),
  features: NeedFeaturesSchema,
}).strict().superRefine((value, context) => {
  const correctBand = value.confidence >= 0.75 ? "high" : "medium";
  if (value.confidenceBand !== correctBand) {
    context.addIssue({
      code: "custom",
      path: ["confidenceBand"],
      message: "confidenceBand must match confidence thresholds",
    });
  }
});
export type NeedCandidate = z.infer<typeof NeedCandidateSchema>;
```

- [ ] **Step 7: Append product, customer, and cart-context contracts**

Append to `src/features/shared/contracts.ts`:

```ts
export const PromotionSchema = z.object({
  id: nonEmptyString,
  label: nonEmptyString,
  price: finiteNonNegative.nullable(),
}).strict();
export type Promotion = z.infer<typeof PromotionSchema>;

export const NutritionFactsSchema = z.object({
  caloriesKcal: finiteNonNegative.nullable(),
  proteinGrams: finiteNonNegative.nullable(),
  fatGrams: finiteNonNegative.nullable(),
  carbohydrateGrams: finiteNonNegative.nullable(),
}).strict();
export type NutritionFacts = z.infer<typeof NutritionFactsSchema>;

const productCandidateShape = {
  productId: nonEmptyString,
  externalProductId: z.number().int().nonnegative(),
  slug: nonEmptyString,
  name: nonEmptyString,
  imageUrl: z.string().url().nullable(),
  price: finiteNonNegative,
  specialPrice: finiteNonNegative.nullable(),
  available: z.boolean(),
  stock: finiteNonNegative,
  step: finitePositive,
  displayRatio: finitePositive,
  nutritionStatus: NutritionStatusSchema,
  nutrition: NutritionFactsSchema.nullable(),
  promotions: z.array(PromotionSchema),
};

function validateProductFacts(
  value: {
    price: number;
    specialPrice: number | null;
    nutritionStatus: NutritionStatus;
    nutrition: NutritionFacts | null;
  },
  context: z.RefinementCtx,
) {
  if (value.specialPrice !== null && value.specialPrice > value.price) {
    context.addIssue({ code: "custom", path: ["specialPrice"], message: "specialPrice cannot exceed price" });
  }
  const nutritionMatches =
    (value.nutritionStatus === "known" && value.nutrition !== null) ||
    (value.nutritionStatus === "insufficient" && value.nutrition === null);
  if (!nutritionMatches) {
    context.addIssue({
      code: "custom",
      path: ["nutrition"],
      message: "nutrition must match nutritionStatus",
    });
  }
}

export const ProductCandidateSchema = z.object(productCandidateShape).strict()
  .superRefine(validateProductFacts);
export type ProductCandidate = z.infer<typeof ProductCandidateSchema>;

export const ProductSearchResultSchema = z.object({
  query: nonEmptyString,
  products: z.array(ProductCandidateSchema),
}).strict();
export type ProductSearchResult = z.infer<typeof ProductSearchResultSchema>;

export const ProductDetailsSchema = z.object({
  ...productCandidateShape,
  description: z.string().nullable(),
  ingredients: z.string().nullable(),
}).strict().superRefine(validateProductFacts);
export type ProductDetails = z.infer<typeof ProductDetailsSchema>;

export const ResolvedNeedSchema = z.object({
  need: NeedCandidateSchema,
  selected: ProductCandidateSchema,
  alternatives: z.array(ProductCandidateSchema),
}).strict().superRefine((value, context) => {
  const ids = [value.selected.productId, ...value.alternatives.map((item) => item.productId)];
  if (!unique(ids)) {
    context.addIssue({ code: "custom", path: ["alternatives"], message: "product IDs must be unique" });
  }
});
export type ResolvedNeed = z.infer<typeof ResolvedNeedSchema>;

export const CustomerContextSchema = z.object({
  familySize: z.number().int().positive().nullable(),
  restrictionKeys: z.array(nonEmptyString).refine(unique, "restrictionKeys must be unique"),
  loyaltyBonusAvailable: finiteNonNegative.nullable(),
}).strict();
export type CustomerContext = z.infer<typeof CustomerContextSchema>;

export const TimeSlotSchema = z.object({
  id: nonEmptyString,
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  available: z.boolean(),
}).strict().superRefine((value, context) => {
  if (Date.parse(value.endsAt) <= Date.parse(value.startsAt)) {
    context.addIssue({ code: "custom", path: ["endsAt"], message: "slot must end after it starts" });
  }
});
export type TimeSlot = z.infer<typeof TimeSlotSchema>;

export const CartContextSchema = z.object({
  cartId: nonEmptyString,
  deliveryType: z.enum(["delivery", "pickup"]),
  city: nonEmptyString.nullable(),
  branchId: nonEmptyString.nullable(),
  slot: TimeSlotSchema,
}).strict().superRefine((value, context) => {
  if (!value.slot.available) {
    context.addIssue({ code: "custom", path: ["slot"], message: "ready cart context needs an available slot" });
  }
});
export type CartContext = z.infer<typeof CartContextSchema>;

export const CartContextResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), context: CartContextSchema }).strict(),
  z.object({ status: z.literal("needs_slot"), availableSlots: z.array(TimeSlotSchema) }).strict(),
]);
export type CartContextResult = z.infer<typeof CartContextResultSchema>;

export const UpdateCartContextInputSchema = z.object({
  deliveryType: z.enum(["delivery", "pickup"]),
  addressId: nonEmptyString.nullable(),
  branchId: nonEmptyString.nullable(),
  slotId: nonEmptyString,
}).strict();
export type UpdateCartContextInput = z.infer<typeof UpdateCartContextInputSchema>;
```

- [ ] **Step 8: Append draft and verified-cart contracts**

Append to `src/features/shared/contracts.ts`:

```ts
export const DraftItemSchema = z.object({
  productId: nonEmptyString,
  externalProductId: z.number().int().nonnegative(),
  name: nonEmptyString,
  quantity: finitePositive,
  price: finiteNonNegative,
  stock: finiteNonNegative,
  step: finitePositive,
  confidence: z.number().finite().min(0.55).max(1),
  confidenceBand: ConfidenceBandSchema,
  reasonCodes: z.array(nonEmptyString).min(1).refine(unique, "reasonCodes must be unique"),
  reason: z.string().trim().min(1).max(160),
  nutritionStatus: NutritionStatusSchema,
  alternatives: z.array(ProductCandidateSchema),
}).strict().superRefine((value, context) => {
  if (value.quantity > value.stock) {
    context.addIssue({ code: "custom", path: ["quantity"], message: "quantity cannot exceed stock" });
  }
  if (!stepAligned(value.quantity, value.step)) {
    context.addIssue({ code: "custom", path: ["quantity"], message: "quantity must align with step" });
  }
  const correctBand = value.confidence >= 0.75 ? "high" : "medium";
  if (value.confidenceBand !== correctBand) {
    context.addIssue({ code: "custom", path: ["confidenceBand"], message: "confidenceBand must match confidence" });
  }
});
export type DraftItem = z.infer<typeof DraftItemSchema>;

export const DraftSchema = z.object({
  id: nonEmptyString,
  mode: DataModeSchema,
  status: DraftStatusSchema,
  algorithmVersion: nonEmptyString,
  trainingCutoff: isoDateTime,
  summary: z.string().trim().max(180),
  items: z.array(DraftItemSchema).max(10),
  total: finiteNonNegative,
  version: z.number().int().positive(),
}).strict().superRefine((value, context) => {
  const ids = value.items.map((item) => item.productId);
  if (!unique(ids)) {
    context.addIssue({ code: "custom", path: ["items"], message: "draft product IDs must be unique" });
  }
  const calculated = value.items.reduce((sum, item) => sum + item.quantity * item.price, 0);
  if (Math.abs(calculated - value.total) > 0.01) {
    context.addIssue({ code: "custom", path: ["total"], message: "total must match item snapshots" });
  }
});
export type Draft = z.infer<typeof DraftSchema>;

export const SetCartProductTargetSchema = z.object({
  productId: nonEmptyString,
  quantity: finitePositive,
}).strict();
export type SetCartProductTarget = z.infer<typeof SetCartProductTargetSchema>;

export const SetCartProductsInputSchema = z.object({
  cartId: nonEmptyString,
  items: z.array(SetCartProductTargetSchema).min(1),
  addQuantity: z.literal(false),
}).strict().superRefine((value, context) => {
  if (!unique(value.items.map((item) => item.productId))) {
    context.addIssue({ code: "custom", path: ["items"], message: "cart product IDs must be unique" });
  }
});
export type SetCartProductsInput = z.infer<typeof SetCartProductsInputSchema>;

export const CartValidationSchema = z.object({
  severity: ValidationSeveritySchema,
  code: nonEmptyString,
  message: nonEmptyString,
  productId: nonEmptyString.nullable(),
}).strict();
export type CartValidation = z.infer<typeof CartValidationSchema>;

export const VerifiedCartItemSchema = z.object({
  productId: nonEmptyString,
  quantity: finitePositive,
  unitPrice: finiteNonNegative,
  available: z.boolean(),
}).strict();
export type VerifiedCartItem = z.infer<typeof VerifiedCartItemSchema>;

const httpsUrl = z.string().url().refine(
  (value) => new URL(value).protocol === "https:",
  "checkout URL must use HTTPS",
);

export const CheckoutLinksSchema = z.object({
  web: httpsUrl,
  mobile: httpsUrl,
}).strict();
export type CheckoutLinks = z.infer<typeof CheckoutLinksSchema>;

export const VerifiedCartSchema = z.object({
  cartId: nonEmptyString,
  status: z.enum(["verified", "partially_committed", "blocked"]),
  items: z.array(VerifiedCartItemSchema),
  total: finiteNonNegative,
  validations: z.array(CartValidationSchema),
  checkoutLinks: CheckoutLinksSchema.nullable(),
}).strict().superRefine((value, context) => {
  const hasError = value.validations.some((validation) => validation.severity === "error");
  if (value.checkoutLinks !== null && (value.status !== "verified" || hasError)) {
    context.addIssue({
      code: "custom",
      path: ["checkoutLinks"],
      message: "checkout requires a verified cart without errors",
    });
  }
});
export type VerifiedCart = z.infer<typeof VerifiedCartSchema>;
```

- [ ] **Step 9: Append the exact provider-neutral gateway port**

Append to `src/features/shared/contracts.ts`:

```ts
export interface SilpoGateway {
  listTools(): Promise<string[]>;
  loadCustomerContext(): Promise<CustomerContext>;
  loadCartContext(): Promise<CartContextResult>;
  updateCartContext(input: UpdateCartContextInput): Promise<CartContext>;
  loadPurchaseHistory(context: CartContext): Promise<RawPurchaseReceipt[]>;
  findProducts(context: CartContext, queries: string[]): Promise<ProductSearchResult[]>;
  getPromotions(context: CartContext): Promise<Promotion[]>;
  getProductDetails(context: CartContext, slug: string): Promise<ProductDetails>;
  getSimilarProducts(context: CartContext, slug: string): Promise<ProductCandidate[]>;
  getTimeSlots(context: CartContext): Promise<TimeSlot[]>;
  setAbsoluteCartQuantities(input: SetCartProductsInput): Promise<void>;
  readCart(cartId: string): Promise<VerifiedCart>;
}
```

- [ ] **Step 10: Implement the sole server environment parser**

Create `src/lib/env.ts`:

```ts
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
```

Do not export `serverEnvSchema`, `isCanonicalBase64`, `postgresUrl`, `encryptionKey`, or a raw environment object.

- [ ] **Step 11: Run focused tests and make Task 2 green**

Run:

```bash
pnpm vitest run src/features/shared/contracts.test.ts src/lib/env.test.ts
```

Expected: PASS. If TypeScript exposes a Zod-version API mismatch, preserve the exact validation behavior from the spec while using the installed Zod release's supported equivalent; do not weaken or delete the test.

- [ ] **Step 12: Run Task 2 cumulative and static/build gates**

Run separately:

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

Expected: every command exits zero. The build must not request environment variables because no App Router entry point calls `getServerEnv` eagerly.

- [ ] **Step 13: Review the shared-contract freeze point**

Run:

```bash
git diff --check
git status --short
git diff -- src/features/shared src/lib
rg -n "process\.env|GOOGLE_GENERATIVE_AI_API_KEY|TOKEN_ENCRYPTION_KEY" src
rg -n "react|next/|@ai-sdk|@modelcontextprotocol|drizzle" src/features/shared/contracts.ts
```

Expected:

- `process.env` appears only as the default argument in `src/lib/env.ts`.
- secret names appear only in the schema and synthetic tests; no real values appear.
- the shared contract imports only Zod.
- no provider SDK or framework type crosses `SilpoGateway`.
- the diff contains no guessed external shapes, duplicate result abstraction, placeholder, or unrelated file.

- [ ] **Step 14: Commit Task 2 separately**

```bash
git add src/features/shared/contracts.ts src/features/shared/contracts.test.ts src/lib/env.ts src/lib/env.test.ts src/lib/result.ts
git commit -m "feat: define application contracts"
```

Expected: one focused Task 2 commit after the Task 1 commit. Record the exact commit hash and do not stage `SILPO_MCP.md`.

---

## Final Verification and Handoff

- [ ] **Step 1: Verify the two-commit history and clean scope**

Run:

```bash
git log -2 --oneline
git status --short
```

Expected: the two implementation commits are in Task 1 then Task 2 order; only the pre-existing `SILPO_MCP.md` remains untracked.

- [ ] **Step 2: Run fresh foundation verification**

Run:

```bash
pnpm vitest run src/app/page.test.tsx
pnpm vitest run src/features/shared/contracts.test.ts src/lib/env.test.ts
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

Expected: all focused, cumulative, static, and build gates pass from fresh invocations.

- [ ] **Step 3: Produce the handoff evidence**

Report:

- changed files grouped by Task 1 and Task 2;
- each command run and whether it passed;
- Task 1 and Task 2 commit hashes;
- confirmation that `SILPO_MCP.md` was untouched;
- any remaining risk, including dependency/toolchain behavior observed during install;
- that Tasks 3, 4, and 7 may start only after the Task 2 commit is integrated.

## Configuration References

- Next.js flat ESLint configuration: <https://nextjs.org/docs/app/api-reference/config/eslint>
- Next.js TypeScript configuration: <https://nextjs.org/docs/app/api-reference/config/typescript>
- Tailwind CSS with Next.js/PostCSS: <https://tailwindcss.com/docs/installation/framework-guides/nextjs>
- Vitest jsdom environment: <https://vitest.dev/guide/environment.html>
- React Testing Library installation: <https://testing-library.com/docs/react-testing-library/intro/>
