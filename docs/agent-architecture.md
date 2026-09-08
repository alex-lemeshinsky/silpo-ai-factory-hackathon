# «Автопілот запасів» — архітектура агента

Статус: нормативний документ для MVP

Цей документ визначає межу між детермінованим кодом і Gemini, модельний workflow, tool surface, structured output, fallback, guardrails та evaluation. Загальна система описана в [project-architecture.md](./project-architecture.md).

## 1. Принцип

Агент не прогнозує запаси «з голови» й не керує кошиком напряму. Детермінований TypeScript-код готує історію, обчислює features, визначає потреби та відбирає реальні доступні продукти. Gemini 3.7 Flash отримує лише цей обмежений набір кандидатів, формулює зрозумілі пояснення й ранжує дозволені альтернативи.

```text
Facts and constraints → deterministic decision support → Gemini wording/ranking
                                                     → schema validation
                                                     → deterministic post-validation
```

Ціна, stock, product IDs, nutrition values, quantity limits, approval і cart state завжди належать серверним джерелам істини.

## 2. Технології та конфігурація

- Vercel AI SDK Core.
- `@ai-sdk/google`.
- Google AI Studio / Gemini Developer API.
- Default model: `gemini-3.7-flash`.
- `AGENT_MODEL=gemini-3.7-flash` дозволяє змінити model adapter без змін domain/UI.
- `thinking: low` за замовчуванням.
- `thinking: medium` дозволений лише для неоднозначного ranking замін.
- Низька випадковість.
- Zod-validated structured output.
- Model-output schemas використовують objects/arrays і не використовують `z.union` або `z.record`.

`GOOGLE_GENERATIVE_AI_API_KEY` існує лише на сервері й ніколи не потрапляє в prompt, client bundle, trace або exception response.

## 3. Відповідальність

Агент:

- створює стислий summary чернетки;
- перетворює reason codes на коротке людське пояснення;
- ранжує тільки надані `alternativeIds`;
- враховує санітизований family/restriction context;
- позначає недостатність nutrition data;
- повертає строго типізований `DraftProposal`.

Агент не:

- обчислює purchase cycles або confidence;
- визначає stock, price, special price, `step` чи `displayRatio`;
- створює product/external IDs;
- шукає довільні продукти поза resolver candidates;
- вигадує nutrition attributes;
- бачить phone, email, address, barcode, profile ID або OAuth token;
- викликає `add_or_update_cart_products`;
- підтверджує чернетку за користувача;
- вирішує, чи можна показати checkout.

## 4. Компоненти

### `PurchaseNormalizer`

Готує однакову історію з offline receipts і online orders. Дедуплікація спрацьовує, якщо записи в межах чотирьох годин, totals відрізняються не більше ніж на 1 грн і overlap external product IDs становить щонайменше 70%. Пакети, доставка, прискорення та службові rows виключаються.

### `PredictionEngine`

Чиста функціональна бібліотека. На вході — `NormalizedReceipt[]`, active city і current date. На виході — відсортовані `NeedCandidate[]` або abstain.

### `ProductResolver`

Шукає exact familiar SKU за артикулом, перевіряє branch availability і будує дозволений список alternatives. Дієтична сумісність є жорстким фільтром, а не ranking-ключем: товар, що порушує обмеження, не пропонується взагалі. Далі ranking policy до Gemini: ціна в межах звичної → активна знижка → відстань за розміром паковання → ціна → `productId` для детермінованого порядку. Орієнтир ціни й паковання — звичний SKU, навіть якщо він зараз недоступний. Nutrition завантажується через `get_product_details` лише для обраного товару; помилка збагачення не скасовує чернетку.

### `DraftAgent`

Model adapter, який будує мінімальний prompt, викликає Gemini, валідує structure і передає результат на post-validation.

### `DraftService`

Оркестратор одного run. Він володіє порядком кроків, timeouts, fallback, persistence та статусом чернетки.

### `CartCommitService`

Не є частиною model loop. Це окремий детермінований сервіс, доступний Route Handler тільки після persisted approval.

## 5. Workflow

```text
SYNC_HISTORY
  → NORMALIZE
  → INFER_NEEDS
  → RESOLVE_SKUS
  → ENRICH
  → CREATE_DRAFT
  → WAIT_FOR_APPROVAL
  → COMMIT_CART
  → VERIFY_CART
```

Model бере участь лише в `CREATE_DRAFT`. `WAIT_FOR_APPROVAL`, `COMMIT_CART` і `VERIFY_CART` виконуються поза LLM.

Детальний draft run:

1. `listTools()` фіксує доступний MCP surface.
2. `loadCartContext()` повертає ready context або `needs_slot`.
3. `loadCustomerContext()` отримує family, restrictions і loyalty summary.
4. `loadPurchaseHistory()` отримує offline/online history.
5. `normalizePurchases()` очищає, дедуплікує і категоризує.
6. `inferNeeds()` обчислює category-first candidates.
7. `resolveProducts()` знаходить фактичні SKU, details і alternatives; знижки читає з полів самого товару, а не з `get_promotions`.
8. Prompt builder видаляє приватні й зайві поля.
9. Gemini повертає `DraftProposal`.
10. Post-validator звіряє кожен ID, quantity, price assumption та alternative з resolver input.
11. Валідна чернетка зберігається з algorithm version і temporal cutoff.

## 6. Prediction Engine v1

Точні формули features, одиниця observation, quantity policy, reason codes та acceptance examples для Tasks 5–6 визначені у [специфікації prediction/backtest](./superpowers/specs/2026-09-03-prediction-backtest-design.md#5-task-5-requirements). Це деталізація наведених нижче інваріантів; реалізація ще не завершена.

### 6.1. Candidate policy

- Вікно історії — максимум 180 днів.
- Exact-SKU candidate потребує мінімум двох observations.
- Category candidate потребує мінімум трьох observations.
- Active city weight — `1.0`; інше місто — `0.35`.
- Кілька чеків однієї короткої поїздки можуть бути об'єднані в ситуативну session.
- Category prediction визначає потребу.
- Exact-SKU history впливає на вибір товару, але не створює high confidence для нестабільного cycle.

### 6.2. Features

- weighted purchase count;
- median interval між покупками;
- median absolute deviation intervals;
- days since last purchase;
- typical quantity;
- частка покупок в active city;
- category repeatability;
- наявність exact familiar SKU.

### 6.3. Confidence

```text
confidence =
  0.40 × due_score
+ 0.35 × repeat_score
+ 0.25 × stability_score
```

Кожна складова clamped до `0..1`. Tie-break — `categoryKey`, щоб результат був стабільним.

- `< 0.55`: abstain;
- `0.55–0.74`: medium;
- `≥ 0.75`: high.

Weights є versioned configuration і змінюються лише після rolling backtest.

## 7. Tool surface

Gemini не отримує всі raw MCP tools. На одному етапі доступно максимум п'ять high-level tools:

- `load_customer_context`;
- `load_purchase_history`;
- `find_available_products`;
- `compare_product_alternatives`;
- `propose_cart_draft`.

Ці tools є вузькими application wrappers. Вони повертають нормалізовані domain objects, а не raw MCP payloads.

Raw MCP mapping поза моделлю:

| High-level operation | MCP tools |
|---|---|
| Customer context | `silpo_get_my_family`, `silpo_get_my_food_restrictions`, `silpo_get_loyalty_info` |
| History | `silpo_get_my_online_orders`, `silpo_get_my_offline_orders` |
| Product search | `silpo_find_products_batch` |
| Enrichment | `silpo_get_promotions`, `silpo_get_product_details` |
| Alternatives | `silpo_get_similar_products`, `silpo_get_replacements` (обидва на порту `SilpoGateway`) |

`commit_confirmed_cart` не доступний Gemini. Route Handler викликає `CartCommitService` лише за наявності server-side approval record.

## 8. Input contract і privacy filter

Model input містить лише:

- mode і locale;
- aggregate family size/context без імен;
- normalized restriction flags;
- `NeedCandidate[]` із confidence і reason codes;
- `ResolvedNeed[]` із дозволеними product IDs, server prices, stock summary, promotions та відомими nutrition attributes;
- copy constraints і output schema.

Model input не містить:

- raw receipts або raw MCP responses;
- full name, phone, email, precise address;
- loyalty barcode або profile identifiers;
- OAuth tokens/headers;
- database keys, session IDs або idempotency keys;
- checkout URLs.

Privacy filter є детермінованою функцією з unit test; одного prompt instruction недостатньо.

## 9. Output contract

```ts
export const DraftProposalSchema = z.object({
  summary: z.string().max(180),
  items: z.array(z.object({
    productId: z.string().min(1),
    externalProductId: z.number().int(),
    quantity: z.number().positive(),
    reason: z.string().max(160),
    alternativeIds: z.array(z.string())
  })).max(10)
});
```

Після Zod parsing сервер перевіряє:

- кожен `productId` і `externalProductId` існує в resolver input;
- alternative IDs належать до того самого resolved need;
- quantity є finite, positive, відповідає `step` і не перевищує stock;
- reason не містить unsupported facts;
- model output не змінює price або nutrition status.

Schema-valid, але семантично invalid output відхиляється.

## 10. Prompt contract

System instruction має:

- пояснити роль: пояснення й ranking, не прогнозування та не checkout;
- наказати використовувати лише надані IDs і facts;
- заборонити вигадувати price, stock, composition, nutrition та promotions;
- вимагати короткі українські explanations;
- позначати `nutritionStatus: insufficient` як «даних недостатньо»;
- не згадувати приватні поля;
- не радити службові rows або plastic bags;
- повернути тільки structured output.

Prompt не дублює бізнес-алгоритм confidence: готовий score і reason codes приходять як facts.

## 11. Loop limits і latency

- Максимум шість model steps для одного draft.
- На кожному step максимум п'ять high-level tools.
- Окремий timeout на MCP call.
- Bounded timeout на повний generation run.
- Завершення одразу після першого valid structured output.
- Максимум дві model attempts для invalid output/provider failure.
- `thinking: medium` вмикається лише для неоднозначного alternative ranking, не для стандартного run.
- Demo p95 target — 2 seconds; live median target — 12 seconds без OAuth/backoff.

## 12. Failure і fallback policy

| Failure | Поведінка |
|---|---|
| Немає valid cart slot | Повернути `needs_slot`; model не запускати |
| Недостатня історія | Abstain або порожня пояснена чернетка |
| Немає доступного SKU | Позначити need unresolved; не робити товар confirmable |
| Немає nutrition data | `insufficient`; нічого не виводити шляхом inference |
| Gemini invalid output | Одна повторна model-спроба після stricter prompt |
| Gemini недоступний після двох спроб | Deterministic proposal із reason-code templates |
| `401` MCP | Одна token refresh-спроба, потім reauthorization |
| `429` read | До трьох bounded retries |
| Невизначений cart write | Не повторювати через model loop; використати persisted absolute targets у commit service |

Deterministic fallback зберігає основну цінність: користувач отримує explainable draft навіть без успішного Gemini response.

## 13. Guardrails

- LLM не має cart-write capability.
- Усі model IDs post-validated за allowlist конкретного run.
- Усі external MCP outputs parsed Zod schemas до потрапляння в agent context.
- Live mode не fallback-иться в demo.
- Draft mode і source run зберігаються разом.
- До write повторно перевіряються price, stock, `step` і slot.
- Bonus/loyalty не застосовується автоматично.
- Model raw prompt/output не логуються.
- Correlation trace містить лише sanitized metadata.

## 14. Evaluation

### Offline rolling backtest

Точні denominator, cold-start policy, baseline, calibration buckets і формат звіту визначені у [специфікації Task 6](./superpowers/specs/2026-09-03-prediction-backtest-design.md#6-task-6-domain-requirements). Значення з відсутнім denominator є `null`; вимога finite `0..1` стосується числових значень. Demo importer окремо перевіряє часові передумови synthetic corpus перед normalization.

Для кожної test receipt модель тренується тільки на events із timestamp раніше за test date. Метрики:

- exact-SKU `precision@K`;
- exact-SKU `recall@K`;
- category `precision@3`;
- category `recall@3`;
- receipt hit rate;
- coverage;
- confidence calibration.

Baseline — most frequent products/categories за попередні 90 днів.

Початкові результати на доступній історії:

- 30 offline receipts;
- 81 unique SKU;
- 12 repeated SKU;
- exact-SKU cycle precision — 2,1%;
- category precision@3 — 42,4%;
- category recall@3 — 60,9%;
- category hit у доступному тестовому зрізі — 11/11 receipts.

Останній показник є ілюстративним результатом ручної категоризації, а не продуктовою обіцянкою.

### Online product metrics

- acceptance rate;
- replacement rate;
- accepted replacement savings;
- model fallback rate;
- invalid-output rate;
- draft latency by mode;
- tool error/retry rate.

За відсутності denominator UI повертає `null` і «Недостатньо спостережень», а не `0%`.

## 15. Tests

- Unit: prediction features, score weights, abstain, time leakage, prompt sanitization, semantic post-validation.
- Contract: model schema compatibility, unknown IDs, unavailable products, missing nutrition fields.
- Integration: ordered orchestration, mode isolation, needs-slot response, deterministic fallback.
- E2E: demo draft remains usable when the model adapter fails.
- Evaluation: rolling metrics finite in `0..1`, cutoff precedes test date, baseline uses only prior 90 days.

## 16. Зміна provider або model

Provider adapter реалізує стабільний `DraftModel` port. Заміна Gemini не повинна змінювати `PredictionEngine`, `ProductResolver`, `DraftProposal` schema, persistence або UI. Перед зміною потрібні:

1. contract tests на structured output;
2. representative eval set;
3. latency/cost comparison;
4. privacy inspection;
5. explicit documentation update.

## 17. Посилання

- [Продуктова специфікація](./product-spec.md)
- [Архітектура проєкту](./project-architecture.md)
- [Дизайн-система](./design-system.md)
- [Задачі](./tasks.md)
- [MCP «Сільпо»](../SILPO_MCP.md)
- [AI SDK MCP](https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools)
- [AI SDK Google provider](https://ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai)
- [Gemini 3.7 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.7-flash)
