# «Автопілот запасів» — архітектура проєкту

Статус: нормативний документ для MVP

Цей документ визначає системні межі, напрям залежностей, зовнішні інтеграції, дані, безпеку, observability, deployment і тестову стратегію. Продуктова поведінка належить [product-spec.md](./product-spec.md), LLM-рішення — [agent-architecture.md](./agent-architecture.md), візуальні правила — [design-system.md](./design-system.md).

## 1. Архітектурні цілі

- Зібрати MVP як один зрозумілий модульний застосунок, який легко запускати локально й на Vercel.
- Відокремити детерміновану бізнес-логіку від Next.js, MCP, Gemini та Postgres.
- Зробити live- і demo-режими взаємозамінними за контрактом, але ніколи не змішувати їхні дані.
- Валідувати кожну зовнішню відповідь на межі системи.
- Зберегти cart write під серверним контролем, поза можливостями LLM.
- Дати агентам вузькі модулі, явні інтерфейси й швидкі команди перевірки.

## 2. Технічний стек

### Application

- Next.js App Router і TypeScript.
- React Server Components для початкового завантаження.
- Route Handlers для OAuth, контексту кошика, генерації, approval, commit і diagnostics.
- Tailwind CSS та CSS custom properties для дизайн-токенів.

### Data and validation

- Postgres для сесій, нормалізованої історії, прогнозів, чернеток, commit records і traces.
- Drizzle ORM для типізованої схеми, міграцій і запитів.
- Zod для runtime-валідації зовнішніх даних і HTTP payloads.

### Integrations

- MCP «Сільпо» через Streamable HTTP та OAuth.
- `@ai-sdk/mcp` і офіційний MCP TypeScript client.
- Vercel AI SDK Core та `@ai-sdk/google` для Gemini.
- Vercel як цільовий deployment.

### Quality

- Vitest для unit, component, contract та integration tests.
- Testing Library для поведінки React-компонентів.
- Playwright для end-to-end і responsive перевірок.
- ESLint і `tsc --noEmit` як статичні gates.

## 3. Системний контекст

```text
Browser
  │ HTTPS
  ▼
Next.js application
  ├── UI / Server Components
  ├── Route Handlers
  ├── Application services
  ├── Pure domain modules
  └── Ports / repositories
       ├── Postgres
       ├── Silpo MCP live adapter
       ├── Silpo demo adapter
       └── Gemini provider adapter
```

Застосунок є modular monolith. Це одна deployable одиниця, але код розділений за бізнес-відповідальністю. Окремі мікросервіси, черги, vector database та distributed workflow для MVP не потрібні.

## 4. Напрям залежностей

```text
UI → Route Handler → Application Service → Domain + Ports
                                         ↑
                          Infrastructure Adapters
```

Правила:

1. `src/features/purchases` і `src/features/prediction` не імпортують React, Next.js, MCP SDK, AI SDK або DB client.
2. Route Handlers не містять scoring, catalog ranking чи idempotency algorithm; вони валідують HTTP, викликають service і маплять результат у response.
3. Application services залежать від портів (`SilpoGateway`, repositories, model adapter), а не від глобальних singleton-клієнтів.
4. Live і demo adapters реалізують той самий `SilpoGateway` і не додають mode-specific поля до спільних domain objects.
5. Gemini adapter не може викликати cart write і не є джерелом істини для ID, ціни, stock, nutrition або quantity limits.
6. Postgres details залишаються всередині repository implementations.

## 5. Модулі та відповідальність

```text
src/
  app/
    api/auth/silpo/{start,callback}/route.ts
    api/cart/{context,commit}/route.ts
    api/drafts/route.ts
    api/drafts/[draftId]/approve/route.ts
    api/backtest/route.ts
    api/demo/diagnostics/route.ts
    dashboard/page.tsx
    layout.tsx
    page.tsx
    globals.css
  components/autopilot/
    app-header.tsx
    draft-dashboard.tsx
    draft-editor.tsx
    draft-product-card.tsx
    draft-summary.tsx
    status-panel.tsx
    demo-diagnostics.tsx
  db/
    client.ts
    schema.ts
  features/
    shared/contracts.ts
    silpo/
      gateway.ts
      oauth/{auth-repository,envelope,provider,service,token-vault,transport}.ts
      live/{history,cart-context,cart,catalog,retry}.ts
      demo/demo-gateway.ts
      schemas/{common,history,cart,catalog}.ts
    purchases/{deduplicate,normalize,categorize}.ts
    prediction/{features,score,backtest}.ts
    products/resolve-products.ts
    agent/{draft-agent,draft-output,prompt}.ts
    drafts/{service,repository}.ts
    cart/{commit-service,repository}.ts
    diagnostics/{backtest-service,service}.ts
  lib/{env,logger,result}.ts
fixtures/demo/silpo-snapshot.json
tests/{contract,integration,e2e}/
```

### `SilpoGateway`

Єдина внутрішня межа для даних «Сільпо». Вона відповідає за OAuth-aware connection, `tools/list`, виклики дозволених MCP tools, Zod-валідацію `structuredContent`, нормалізацію помилок і санітизований trace.

Очікуваний контракт:

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

### `SilpoOAuthService` та OAuth-підсистема

Оркеструє потік авторизації «Сільпо» (Authorization Code + PKCE), керує безпечними браузерними сесіями та взаємодією з офіційним MCP SDK:
- `auth-repository.ts`: типізоване збереження сесій (`auth_sessions`) та OAuth-стану (`silpo_oauth_states`) із PostgreSQL- та in-memory реалізаціями, CAS-переходами фаз (`idle` → `pending` → `processing`) і опортуністичним очищенням прострочених записів;
- `envelope.ts`: спільний безпечний примітив шифрування AES-256-GCM для збереження чутливих бінарних envelopes;
- `token-vault.ts`: сховище зашифрованих access/refresh токенів «Сільпо» з AAD на основі `userId`;
- `provider.ts`: реалізація контракту `OAuthClientProvider` офіційного MCP TypeScript SDK, підключена до сховища стану та токенів;
- `transport.ts`: клієнтський транспорт Streamable HTTP, єдиний власник оновлення токенів (one-refresh owner), обмеження таймаутів (10 с на запит, 30 с на потік) і перевірка доступності через `tools/list`;
- `live/session.ts`: read- і write-сесії MCP поверх спільного hardened fetch із `transport.ts`; обов'язковий `tools/list` на старті сесії та відмова від будь-якого нерекламованого tool;
- `live/retry.ts`: чистий bounded-retry (250/500/1000 ms + jitter, максимум три спроби), єдине джерело драбини затримок у репозиторії;
- `service.ts`: високорівневий сервіс авторизації, що виконує start redirect, атомарний callback claim, ротацію сесійних хендлів та резолвінг сесій (`resolveSilpoSession`).

Сесії та потік мають фіксовані строки дії: pending потік живе щонайбільше 10 хвилин, авторизована сесія — 7 днів (абсолютний строк, non-sliding). Успішний вхід ротує сесію та скеровує на кореневий маршрут застосунку (`/`). Деталі — у [специфікації Silpo OAuth](./superpowers/specs/2026-09-06-silpo-oauth-design.md).

### `PurchaseNormalizer`

Об'єднує online/offline purchases, дедуплікує замовлення і фіскальний чек, виключає службові рядки, нормалізує назви, units, quantity, article, city та channel. Категоризація спочатку використовує детерміновані правила; невідоме значення лишається `uncategorized`.

### `PredictionEngine`

Чиста TypeScript-бібліотека. Приймає нормалізовану історію та повертає категоріальні `NeedCandidate` із числовими features, confidence і reason codes. Деталі алгоритму визначає [agent-architecture.md](./agent-architecture.md).

### `ProductResolver`

Перетворює потребу на актуальний SKU. Спочатку шукає відомий `externalProductId`, потім перевіряє `available`, `stock`, `step`, `displayRatio`, price/special price, restrictions і branch/company identifiers. Недоступний товар не повертається як confirmable.

### `DraftService`

Оркеструє gateway, normalizer, predictor, resolver, Gemini і repository. Зберігає `algorithmVersion`, `trainingCutoff`, reason codes, price snapshots і data mode.

`createDraftForUser({ userId, mode, correlationId }, deps)` повертає `Result<DraftRun, DraftFailure>`, де `DraftRun` містить `draft`, `cartContext`, `loyaltyBonusAvailable` і sanitized `generation` (`source`, `attempts`, `normalizations`) для метрик Task 17. Кожен запуск створює нову чернетку з `version: 1`; попередні чернетки лишаються рядками історії.

`createSilpoGateway({ mode, userId, publicBaseUrl })` повертає `SilpoGatewayHandle` — `{ gateway, close() }`. Live-композиція відкриває один read session і lazy write session, який створюється лише за потреби bootstrap кошика. Mode фіксується під час створення; live ніколи не повертає demo gateway.

Demo mode персистує чернетки під синтетичним користувачем `DEMO_USER_ID`, який ідемпотентно створюється перед першим запуском. Це зберігає єдиний шлях персистенції для live і demo.

Деталі — у [специфікації Task 13](./superpowers/specs/2026-09-08-draft-orchestration-design.md).

### `CartCommitService`

Єдина точка cart write. Перевіряє persisted approval, slot, stock і quantity; зберігає absolute targets до write; виконує write; негайно перечитує кошик; зберігає verified або blocked result.

### `DiagnosticsService`

Поєднує rolling backtest, product-decision metrics і санітизовані tool traces. Diagnostics route доступний лише в demo mode.

Task 6 створює окремий `diagnostics/backtest-service.ts`: application service отримує injected `SilpoGateway`, перевіряє synthetic corpus, нормалізує історію та викликає pure evaluator. `/api/backtest` виконує лише mode gating, composition і HTTP mapping. Task 17 зберігає відповідальність за `diagnostics/service.ts` та загальну diagnostics aggregation. Деталі — у [специфікації Tasks 5–6](./superpowers/specs/2026-09-03-prediction-backtest-design.md#7-task-6-application-requirements).

## 6. HTTP surface

| Endpoint | Method | Відповідальність |
|---|---|---|
| `/api/auth/silpo/start` | GET | Почати OAuth із state та PKCE |
| `/api/auth/silpo/callback` | GET | Перевірити state, завершити OAuth, зберегти токени |
| `/api/cart/context` | POST | Встановити вибраний слот і повернути verified context |
| `/api/drafts` | POST | Побудувати та зберегти персональну чернетку |
| `/api/drafts/:draftId/approve` | POST | Зберегти явне approval та idempotency key |
| `/api/cart/commit` | POST | Ідемпотентно записати approved quantities й verify cart |
| `/api/backtest` | GET | Повернути rolling backtest лише в demo mode |
| `/api/demo/diagnostics` | GET | Повернути demo metrics і sanitized traces |

HTTP input проходить Zod-валідацію. Session ownership перевіряється в кожному user-scoped route. Доменно очікувані стани повертаються як typed result, а не як довільні exception strings.

## 7. Основні потоки даних

### 7.1. OAuth і live session

```text
Browser → /api/auth/silpo/start
  → resolve/create user + pending session (cookie: silpo_session, handle hash)
  → persist encrypted OAuth state (PKCE verifier, state, flow ID, 10 min lifetime)
  → 303 Redirect to Silpo authorization endpoint (або tools/list probe + ротація, якщо вже авторизовано)
  → Browser confirms Silpo authorization
  → /api/auth/silpo/callback
  → parse query & match unexpired user pending flow
  → atomic CAS claim: pending → processing (binding hash & version match)
  → transport.finishAuth(code, iss)
  → encrypt & save tokens in vault (AES-256-GCM)
  → connection probe via tools/list
  → atomic session rotation: revoke every handle of the internal user, issue authenticated session (7 days lifetime)
  → clear pending flow secrets
  → 303 Redirect to fixed application landing (/) with rotated cookie
```

Правила сесій та автентифікації:
- Браузер отримує лише непрозорий криптографічний хендл (32 байти base64url) у cookie `silpo_session` (`HttpOnly`, `SameSite=Lax`, `Path=/`, host-only, `Secure` у production). У базі зберігається виключно SHA-256 дайджест (`handle_hash`). Клієнтський `userId` ніколи не приймається з тіла, заголовків чи query.
- Строк дії pending flow та pending cookie — не більше 10 хвилин (600 с). Строк дії авторизованої сесії — 7 днів (604 800 с, абсолютний, non-sliding).
- Успішна ротація в одній транзакції відкликає всі наявні хендли внутрішнього користувача, а не лише хендл поточного flow: після повторної авторизації попередній authenticated-хендл (у тому числі скопійований) більше не діє.
- Політика призначення однакова для серверних запитів і для браузерного редиректу авторизації: лише HTTPS, без приватних, loopback і link-local адрес, і лише origin прив'язаного authorization server. Неповні або невалідні discovery-метадані відхиляються — endpoint'и ніколи не добудовуються за здогадом.
- Редирект зі зміною origin ніколи не переносить облікові дані: заголовки `Authorization`, `Cookie`, `Proxy-Authorization` знімаються, а тіло запиту (grant або реєстрація клієнта) на інший origin не повторюється. Пауза за `Retry-After` обмежена залишком 30-секундного бюджету операції.
- Фіксований landing після успішного входу — кореневий маршрут застосунку (`/`). Авторизація не генерує чернетку автоматично й не позначає демо-дані як live (це зона відповідальності Tasks 13–14).
- Єдиний власник оновлення токенів (one-refresh owner) — транспорт `transport.ts`: дозволена максимум одна спроба оновлення токенів на логічну операцію читання. Операції запису кошика (Task 16) використовують окремий bearer-only транспорт без авто-оновлення.
- Атомарний claim колбеку (`pending` → `processing`) через compare-and-swap (CAS) з перевіркою версії, binding hash і строку дії усуває гонки й гарантує одноразовість колбеку (replay protection). При паралельному запиті або повторі другий запит отримує `unauthorized` без виклику мережевого обміну коду.
- Повний опис протоколу, валідації та життєвого циклу — у [специфікації Silpo OAuth](./superpowers/specs/2026-09-06-silpo-oauth-design.md).

### 7.2. Cart context

```text
tools/list
→ get_my_shopping_cart
→ якщо є: get_shopping_cart_by_id → get_time_slots
→ якщо немає: find_address → get_available_delivery_types
  → optional list_branches → get_time_slots → create_shopping_cart
  → get_shopping_cart_by_id → get_time_slots
```

Expired slot повертає `needs_slot` і доступні слоти. Cart-dependent history/catalog operations не продовжуються до вибору валідного слота. Оновлення слота копіює address і shipments із readback, викликає `silpo_update_shopping_cart`, потім одразу перечитує і перевіряє контекст — і слот, і спосіб доставки.

`CartContext.deliveryType` має два значення там, де «Сільпо» документує вісім, тому зворотне відображення заборонене: реальний тип завжди береться з readback кошика. Запит на зміну способу доставки резолвиться через `silpo_get_available_delivery_types`; запит на зміну адреси відхиляється явно, бо адреса копіюється з readback без змін. Жодне поле входу не приймається мовчки без наслідків.

### 7.3. Draft generation

```text
customer + cart context
→ online/offline history
→ normalize + deduplicate
→ infer category needs
→ resolve available SKUs
→ enrich promotions/details/alternatives
→ Gemini explanation/ranking
→ post-validation
→ persist draft
→ render dashboard
```

Повне ім'я, телефон, email, точна адреса, loyalty barcode та profile IDs не передаються Gemini.

### 7.4. Cart commit

1. Прийняти `draftId` і persisted idempotency key.
2. Перевірити ownership, version і approval.
3. Для завершеного key повернути збережений result без нового write.
4. Перечитати кошик і негайно перевірити слот.
5. Повторно знайти SKU та перевірити stock, price і `step`.
6. Один раз обчислити absolute target: current quantity + approved addition.
7. До write зберегти key, absolute targets і `pending`.
8. Викликати `silpo_add_or_update_cart_products` з `addQuantity=false`.
9. Негайно перечитати кошик і validations.
10. Зберегти `verified` або `blocked` result.
11. Повернути web/mobile checkout links лише без error validations.

Після невизначеного network result повтор використовує вже збережені absolute targets. Він не додає approved quantity до оновленого кошика вдруге.

## 8. Дані

Основні таблиці:

- `users`: внутрішній ID і мінімальні settings;
- `mcp_connections`: окремі AES-256-GCM ciphertext, IV і auth tag, expiry, scope та OAuth metadata; legacy ciphertext зберігається до окремої безпечної міграції, а partial unique index дозволяє лише один new-format envelope на користувача;
- `auth_sessions`: внутрішній session ID, `user_id` (FK → `users`, delete cascade), unique SHA-256 `handle_hash`, `status` (`pending`, `authenticated`, `revoked`, CHECK-обмеження), `expires_at` (до 10 хв для pending, 7 днів для authenticated), `created_at`; індекси по `user_id` та `expires_at`;
- `silpo_oauth_states`: unique `user_id` (FK → `users`, delete cascade), `version` positive integer (CHECK `> 0`), `phase` (`idle`, `pending`, `processing`, CHECK-обмеження), nullable `binding_hash`, nullable `flow_expires_at` (до 10 хв від старту; CHECK вимагає binding hash і строк дії для активного flow), окремі AES-256-GCM `ciphertext`, `iv`, `auth_tag` для збереження зашифрованих pending flow ID, state, PKCE verifier, client registration та discovery binding, `updated_at`; кожен прочитаний рядок валідується схемою перед використанням;
- `purchase_receipts`: channel, timestamp, city, totals, external fingerprint;
- `purchase_items`: receipt, external product ID, category, quantity, unit price;
- `product_snapshots`: product/external ID, branch, price, stock, attributes, `captured_at`;
- `prediction_runs`: algorithm version, temporal cutoff, metrics, status;
- `predicted_needs`: category, features, confidence, reason codes;
- `drafts`: user, source run, mode, status, total, version;
- `draft_items`: resolved product, quantity, price snapshot, reason, user decision, version;
- `cart_commits`: idempotency key, confirmation timestamp, absolute target quantities, result;
- `tool_traces`: correlation ID, tool name, mode, duration, retry count, sanitized status;
- `draft_approvals`: draft, user, idempotency key, approval timestamp.

Вимоги:

- UUID primary keys і UTC timestamps.
- Unique `purchase_receipts.external_fingerprint` і `cart_commits.idempotency_key`.
- Foreign keys мають явну delete policy.
- JSONB використовується лише для sanitized features, result і trace metadata.
- Raw MCP response не зберігається без окремої доведеної потреби.
- Demo snapshot не містить реальних tokens, names, phones, addresses, loyalty identifiers або order IDs.
- Атомарні CAS-переходи у `silpo_oauth_states` (`version` compare-and-swap) усувають race conditions та забезпечують одноразовість обробки callback у конкурентному середовищі.
- AAD-сегрегація шифрування: токени у `mcp_connections` шифруються з AAD `<userId>`, а auth state у `silpo_oauth_states` — з AAD `silpo-oauth-state:v1:<userId>`, унеможливлюючи перенесення шифротексту між таблицями чи користувачами.
- Опортуністичне очищення прострочених записів сесій користувача під час старту нового потоку.
- Деталі схеми та контрактів збереження — у [специфікації Silpo OAuth](./superpowers/specs/2026-09-06-silpo-oauth-design.md#o9-02--durable-persistence-and-encryption).

## 9. Помилки та retry policy

Нормалізовані категорії помилок:

- `unauthorized`: одна refresh-спроба, потім reauthorization;
- `rate_limited`: bounded retry metadata для клієнта;
- `needs_slot`: HTTP 409 з доступними слотами;
- `invalid_external_data`: schema mismatch без продовження на guessed shape;
- `unavailable_product`: replacement або remove;
- `cart_validation_error`: blocked result без checkout;
- `partial_commit`: per-item status і user action;
- `model_invalid_output`: максимум дві model-спроби, потім deterministic fallback;
- `unexpected`: correlation ID і safe message без secrets.

Read-only MCP calls після `429` повторюються не більше трьох разів. Використовується server retry metadata або 250/500/1000 ms + jitter. Cart writes автоматично не повторюються.

Політика повторів та оновлення авторизації:
- Єдиний власник оновлення токенів (`transport.ts`): рівно одна спроба оновлення токена на логічну операцію читання. Якщо оновлення зазнало невдачі або повернуло повторний 401, облікові дані інвалідуються, а потік завершується помилкою `unauthorized`, що вимагає повторного входу.
- Обмін коду авторизації (`finishAuth`), динамічна реєстрація клієнта та запити оновлення токенів не є idempotent read-only операціями і ніколи не повторюються автоматично.
- Bounded network deadlines: таймаут окремого мережевого виклику авторизації становить 10 с, загальний дедлайн мережевої фази start/callback — 30 с.
- Операції запису кошика використовують окремий bearer-only транспорт (`openWriteSession`) без авто-відновлення чи refresh/retry: 401 на записі негайно повертає контроль без повторного оновлення токенів чи повторного виклику мутації. Транспорт уводить Task 10 (перший запис кошика — встановлення контексту доставки); Task 16 використовує його без змін.
- Retry для read-only викликів виконується на рівні `callTool`, а не fetch: у HTTP-шарі read і cart write однаково є `POST /mcp` і не розрізняються. Write-сесія не має коду retry взагалі.
- `SdkHttpError` не несе заголовків відповіді, тому `Retry-After` перехоплюється на рівні fetch (де ще існує сирий `Response`) і додається до `McpCallError`. Без цього серверні retry-метадані були б недосяжні, а клієнт ніколи не отримував би `retryAfterMs`.
- Усі помилки мапляться в стандартизовані безпечні повідомлення без витоку URL, query, заголовків чи стек-трейсів згідно з [специфікацією Silpo OAuth](./superpowers/specs/2026-09-06-silpo-oauth-design.md#o9-06--one-refresh-owner-and-readwrite-separation).

## 10. Безпека та приватність

- `GOOGLE_GENERATIVE_AI_API_KEY`, DB credentials і MCP tokens є server-only.
- `TOKEN_ENCRYPTION_KEY` декодується в рівно 32 bytes.
- OAuth tokens та OAuth state шифруються AES-256-GCM з випадковим 12-byte IV та authenticated tag через спільний примітив `envelope.ts`.
- AAD-сегрегація: токени шифруються з AAD `<userId>`, а auth state — з AAD `silpo-oauth-state:v1:<userId>`, що унеможливлює трансплантацію шифротексту між таблицями чи користувачами.
- Сесійні хендли формуються з 32 випадкових криптографічних байтів (base64url); у базі зберігається лише їхній SHA-256 хеш (`handle_hash`). Cookie `silpo_session` має атрибути `HttpOnly`, `SameSite=Lax`, `Path=/`, host-only, `Secure` у production.
- Строк дії pending-хендлів — до 10 хвилин; авторизованих сесій — 7 днів (абсолютний, non-sliding). Успішний callback атомарно ротує сесійний хендл та відкликає старий.
- Атомарний claim колбеку через CAS (`pending` → `processing`) запобігає race conditions та атакам повторного відтворення (replay).
- Чутливі параметри OAuth (PKCE verifier, client secret) шифруються в стані й безповоротно стираються після завершення чи скасування потоку; authorization code ніколи не зберігається в базі даних.
- Відповіді авторизаційних маршрутів завжди повертають `Cache-Control: no-store` та `Referrer-Policy: no-referrer`.
- Authorization headers, tokens, phone, email, address, barcode, profile IDs, raw prompts і raw MCP payloads редагуються до persistence та console output.
- Client отримує лише мінімальні serialized domain objects.
- Cart write неможливий без server-side approval record.
- Checkout неможливий для blocked result.
- Live smoke за замовчуванням read-only; write smoke запускається лише після свіжого ручного підтвердження.
- `SILPO_MCP.md` є read-only integration contract, якщо користувач окремо не попросив його змінити.
- Повний перелік гарантій безпеки наведено в [специфікації Silpo OAuth](./superpowers/specs/2026-09-06-silpo-oauth-design.md).

## 11. Observability

Кожен draft run отримує correlation ID. Structured trace містить:

- correlation ID;
- data mode;
- tool/service name;
- duration;
- retry count;
- prediction algorithm version;
- item count;
- normalized status.

У demo mode користувач може відкрити панель «Як працює прогноз» із backtest summary та санітизованими rows `tool / duration / status`. Raw inputs, outputs та user identifiers не відображаються.

## 12. Performance budgets

- Demo draft: p95 ≤ 2 seconds від request до `ready`, 20 warm runs.
- Live read-only draft: median ≤ 12 seconds, 10 runs, без interactive OAuth та external rate-limit backoff.
- Live p95 вимірюється, але не є release gate MVP.
- MCP calls мають окремий timeout; повна генерація має bounded timeout.
- Gemini завершує роботу після першого valid structured output.

## 13. Testing pyramid

### Unit

- purchase deduplication і service-row filtering;
- category/unit normalization;
- median intervals, MAD, location weighting, confidence і abstain;
- no time leakage;
- product ranking і restrictions;
- absolute cart quantities та idempotency;
- trace redaction.

### Component

- dashboard hierarchy and states;
- confidence, reason, stock, price, loyalty copy;
- edit/remove/replace/quantity interactions;
- checkout visibility rules;
- diagnostics disclosure.

### Contract

Zod fixtures покривають tools list, missing cart, expired slot, zero stock, price change, partial availability, `401`, `429`, malformed response, warnings/errors і live/demo parity.

### Integration

- OAuth state/PKCE/token persistence;
- реальна перевірка конкурентності та життєвого циклу в PostgreSQL (`tests/integration/silpo-oauth-postgres.test.ts`): валідація атомарного CAS claim колбеку (single-winner гарантія проти replay), ротації та відкликання сесій, каскадного видалення та ізоляції користувачів у реальній БД під паралельним навантаженням (запускається окремо через `pnpm vitest run tests/integration/silpo-oauth-postgres.test.ts` згідно з [матрицею прийняття](./superpowers/specs/2026-09-06-silpo-oauth-design.md#7-acceptance-matrix));
- draft orchestration order;
- approval ownership/version/idempotency;
- cart commit/readback;
- demo diagnostics route.

### End-to-end

```text
demo sign in/context → history → prediction → draft
→ edit → approve → commit → verify → checkout
```

Гарантії: no write before approval; retry не збільшує кількість двічі; unavailable item не додається; checkout прихований при error validation; demo banner видимий; partial failure показаний per item.

## 14. Deployment і конфігурація

Required server variables:

```text
DATABASE_URL
TOKEN_ENCRYPTION_KEY
GOOGLE_GENERATIVE_AI_API_KEY
AGENT_MODEL=gemini-3.7-flash
DATA_MODE=live
PUBLIC_BASE_URL
```

`getServerEnv()` є єдиною точкою читання та Zod-валідації environment. Raw `process.env` не експортується. `.env.example` містить лише names, без values.

Deployment target — Vercel + managed Postgres. Міграції виконуються явно перед production rollout. Demo mode має бути придатним для локального запуску без live Silpo write.

## 15. Архітектурні критерії готовності

- Усі зовнішні дані проходять runtime validation.
- Provider Gemini можна замінити без змін prediction engine або UI.
- Live і demo adapters проходять один contract suite.
- Кожен prediction run має algorithm version і temporal cutoff.
- Кожен cart commit має idempotency key і verified/blocked result.
- Залежності відповідають напрямку з розділу 4.
- Focused, cumulative, build і E2E checks проходять.

## 16. Посилання

- [Продуктова специфікація](./product-spec.md)
- [Архітектура агента](./agent-architecture.md)
- [Дизайн-система](./design-system.md)
- [Задачі](./tasks.md)
- [MCP «Сільпо»](../SILPO_MCP.md)
