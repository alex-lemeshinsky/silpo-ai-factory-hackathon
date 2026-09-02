# «Автопілот запасів» — дизайн-система MVP

Статус: нормативний документ для UI

Дизайн наслідує теплу, просту й грайливу мову silpo.ua, але не копіює логотип, ілюстрації, proprietary assets або компоненти «Сільпо». Продукт має власний wordmark «Автопілот» і залишається візуально відмінним.

## 1. Принципи

### Action first

Користувач одразу бачить готову чернетку й головну дію. Немає chat-first навігації, обов'язкового onboarding або технічного MCP-жаргону в основному сценарії.

### Explain before asking

Кожен товар показує, чому він запропонований, наскільки система впевнена, скільки він коштує і чи є в наявності. Confirm ніколи не випереджає пояснення або validation.

### Warm, not childish

М'які поверхні, округлі форми та яскраві accents створюють доброзичливість. Дані, ціни та помилки залишаються стриманими й легко скануються.

### Trust is visible

Live/demo mode, loading, uncertainty, недостатні nutrition data, price changes, stock limits і cart validations завжди мають явне текстове представлення. Колір не є єдиним сигналом.

### One primary action

У кожному стані є не більше одного домінантного синього CTA. Secondary дії нейтральні або outline. Destructive remove не конкурує з confirm.

## 2. Brand boundary

Дозволено:

- споріднена orange/blue palette;
- pill controls;
- світле бузкове тло;
- великі білі rounded sections;
- реальні product images;
- абстрактні playful shapes;
- дружня українська мікрокопія.

Заборонено:

- копіювати логотип або wordmark «Сільпо»;
- використовувати brand illustrations без ліцензії;
- видавати вебзастосунок за офіційний інтерфейс «Сільпо»;
- копіювати proprietary font files без підтвердженого права;
- приховувати, що demo data не є live data.

Wordmark MVP: текст «Автопілот» із власною простою геометричною позначкою. Поруч у product copy можна написати «працює з кошиком “Сільпо”», але не вбудовувати чужий знак у наш logo lockup.

## 3. Color tokens

```css
:root {
  --autopilot-orange: #fe8522;
  --autopilot-blue: #2358d1;
  --autopilot-ink: #202124;
  --autopilot-bg: #f5f5fb;
  --autopilot-lilac: #eeeafb;
  --autopilot-green: #c7df9c;
  --autopilot-surface: #ffffff;
  --autopilot-muted: #6b6f76;
  --autopilot-border: #e2e3e8;
  --autopilot-success: #26734d;
  --autopilot-warning: #9a5b00;
  --autopilot-danger: #b42318;
  --autopilot-focus: #0b57d0;
}
```

Ролі:

| Token | Використання |
|---|---|
| Orange | brand accent, decorative shapes, selected highlights |
| Blue | primary CTA, active links, focus-compatible actions |
| Ink | headings і основний текст |
| Background | page canvas |
| Lilac | forecast/demo/supporting sections |
| Green | savings/promotions із текстовим label |
| Surface | cards, dialogs, sticky summary |
| Muted | secondary copy; не використовувати для critical status |
| Warning/Danger | cart validations разом з icon і text |

Orange і pale green не використовуються як дрібний text на white без окремої contrast перевірки. Primary blue button має white text. Усі фактичні foreground/background pairs перевіряються на WCAG AA.

## 4. Typography

Не завантажувати `Silpo Text` або інший proprietary font без ліцензії. MVP використовує system-first rounded sans stack:

```css
font-family: Inter, ui-rounded, "SF Pro Rounded", "Segoe UI", sans-serif;
```

Якщо пізніше з'явиться ліцензований brand-adjacent font, він замінюється через один token без зміни components.

Type scale:

| Role | Desktop | Mobile | Weight | Line height |
|---|---:|---:|---:|---:|
| Display | 48 px | 34 px | 700 | 1.05 |
| H1 | 36 px | 30 px | 700 | 1.12 |
| H2 | 28 px | 24 px | 700 | 1.2 |
| H3 | 20 px | 18 px | 650 | 1.3 |
| Body | 16 px | 16 px | 400 | 1.5 |
| Small | 14 px | 14 px | 400 | 1.45 |
| Label | 13 px | 13 px | 600 | 1.25 |

Ціни використовують tabular numerals. Не використовувати all caps для довгих українських labels.

## 5. Spacing, sizing і shape

Base unit — 4 px.

```text
space-1  4 px
space-2  8 px
space-3  12 px
space-4  16 px
space-5  20 px
space-6  24 px
space-8  32 px
space-10 40 px
space-12 48 px
space-16 64 px
```

Radii:

```text
radius-sm    10 px  inputs, small badges
radius-md    16 px  product cards
radius-lg    24 px  main sections
radius-xl    32 px  hero
radius-pill  999 px buttons, filters, confidence labels
```

Controls мають мінімальну touch target 44×44 px. Product image container — square, `object-fit: contain`, із neutral background. Shadow використовується лише для elevation sticky bar/dialog, а не для кожної card:

```css
--shadow-raised: 0 12px 32px rgb(32 33 36 / 12%);
```

## 6. Layout

Page max width — 1280 px, centered. Horizontal padding:

- 16 px до 599 px;
- 24 px від 600 px;
- 32 px від 1024 px.

Product grid:

- `< 600 px`: 1 column;
- `600–899 px`: 2 columns;
- `900–1199 px`: 3 columns;
- `≥ 1200 px`: 4 columns, якщо card не стає вужчою за 260 px.

Dashboard order незмінний:

1. Header зі способом отримання, магазином і кошиком.
2. Hero «N товарів уже просяться до кошика», сума і CTA.
3. Cards «Прогноз» та «Вигода».
4. Section «Ймовірно закінчується».
5. Product grid.
6. Sticky confirmation summary.
7. У demo mode — collapsed diagnostics «Як працює прогноз».

На mobile sticky summary займає всю нижню ширину й не перекриває останню card; page має відповідний bottom padding. На desktop summary може бути sticky side/bottom panel залежно від доступної ширини.

## 7. Core components

### `AppHeader`

Показує wordmark, delivery/pickup context, поточний branch/address summary без зайвих персональних даних, cart indicator і connection status. На mobile другорядні context details згортаються.

### `DraftHero`

Містить кількість рекомендованих items, total snapshot, короткий summary і primary CTA. Поки draft не `ready`, CTA замінюється progress/status copy. До `verified` hero не показує checkout.

### `ForecastCard`

Пояснює, скільки регулярних needs знайдено, history window і confidence distribution. Не подає ілюстративний baseline як product guarantee.

### `SavingsCard`

Показує verified promotions і потенційну економію. Loyalty bonus відображається окремо як «доступно», не віднімається від total без окремої майбутньої згоди.

### `DraftProductCard`

Обов'язкові поля:

- real product image або neutral placeholder;
- product name і package amount;
- current/special price;
- stock state;
- confidence label;
- короткий reason;
- quantity stepper;
- replace action;
- remove action;
- nutrition state або «даних недостатньо»;
- per-item validation після commit.

Unavailable card не має confirmable state. При changed price/stock старе і нове значення показуються до write.

### `ConfidenceBadge`

- Medium: текст «Середня впевненість».
- High: текст «Висока впевненість».

Badge не покладається лише на color. Числовий score можна показувати в details, але не обов'язково в primary card scan.

### `QuantityStepper`

Працює з server-provided `step`, `displayRatio` і stock cap. Invalid quantity блокує confirm і має inline message. Buttons мають accessible names.

### `AlternativePicker`

Порівнює лише available candidates. Показує price/package/promotion і nutrition лише тоді, коли дані є з обох сторін. Selected replacement оновлює total із server price snapshot.

### `StatusPanel`

Використовується для `syncing`, `generating`, `needs_slot`, reauthorization, rate limit, blocked і partial results. Має заголовок, короткий next step і одну primary action.

### `DraftSummary`

Sticky surface із item count, total і CTA «Додати у кошик “Сільпо”». Disable states мають пояснення. Подвійне натискання не створює другий approval/commit.

### `ValidationList`

Error rows блокують checkout; warning rows ні, але завжди видимі. Кожен row має severity icon, text і, якщо можливо, конкретну action.

### `CheckoutActions`

Показуються тільки для `verified` cart без error validations:

- «Оформити на сайті»;
- «Оформити в застосунку».

### `DemoBanner`

Завжди видимий у demo mode, не dismissible на час session, текст «Демонстраційні дані». Банер не стилізується як warning про помилку.

### `DemoDiagnostics`

Collapsed by default. Показує backtest metrics і sanitized MCP trace `tool / duration / status`. Не показує raw request/response, tokens або user identifiers.

## 8. State presentation

| Domain state | UI behavior |
|---|---|
| `syncing` | Skeleton/history progress; editing hidden |
| `generating` | Forecast progress; no confirm |
| `ready` | Editable cards і enabled confirm за валідного selection |
| `confirming` | Controls locked; «Перевіряємо ціну та наявність» |
| `partially_committed` | Verified items + per-item attention; checkout hidden, якщо є error |
| `verified` | Success summary, validations, web/mobile checkout |
| `blocked` | Error panel, corrective action, no checkout |
| `needs_slot` | Slot picker before cart-dependent continuation |
| `reauthorization` | Reconnect action; live data не замінюються demo |
| `rate_limited` | Retry timing із server metadata |
| `demo` | Persistent demo banner поверх applicable state |

## 9. Interaction rules

- Primary CTA ніколи не викликає cart write до persisted approval.
- Confirm disabled, якщо є unresolved replacement або quantity порушує `step`/stock.
- Price total завжди походить із server snapshots, а не client arithmetic as source of truth.
- Після confirm UI переходить у `confirming`, блокує повторне submit і чекає verified readback.
- Warning не маскується success-state; error не маскується checkout link.
- Якщо item видалено, його повернення є явною undo/add action.
- Focus не губиться після async update; status changes мають оголошуватися через live region.
- Не використовувати optimistic success для зовнішнього cart write.

## 10. Accessibility

- WCAG 2.2 AA як ціль MVP.
- Повна keyboard navigation для header, product controls, picker, diagnostics і checkout.
- Visible focus ring через `--autopilot-focus`.
- Touch target мінімум 44×44 px.
- Semantic headings і один H1 на page.
- Buttons використовуються для actions, links — для navigation/checkout.
- Icons мають accessible name або `aria-hidden`, якщо decorative.
- Status/progress оголошується без focus stealing.
- Error association через `aria-describedby`; form summary веде до першої invalid control.
- Не покладатися лише на color, hover або animation.
- `prefers-reduced-motion` вимикає non-essential transitions.
- Product images мають змістовний alt із назвою товару; decorative shapes — порожній alt.

## 11. Motion

Motion короткий і функціональний:

- hover/focus transition: 120–160 ms;
- section/state transition: 180–240 ms;
- skeleton shimmer дозволений лише без reduced-motion;
- success може мати один subtle scale/fade, але не confetti у критичному checkout flow.

Жодна animation не затримує доступ до даних або CTA.

## 12. Мікрокопія

Тон: дружній, конкретний, без надмірної персоніфікації агента.

Добре:

- «Схоже, вода скоро закінчиться».
- «Купуєте приблизно раз на 6 днів».
- «Ціна змінилася з моменту створення чернетки».
- «Для цього товару недостатньо даних про склад».
- «Кошик потребує уваги».

Не використовувати:

- «Я точно знаю, що вам потрібно»;
- «Ми вже купили це за вас»;
- технічні error codes без перекладу;
- «економія», якщо вона не порахована на verified prices;
- «здоровіше», якщо nutrition data неповні.

## 13. Responsive acceptance

Обов'язкова перевірка мінімум на 390 px і 1440 px:

- немає horizontal overflow;
- sticky summary не перекриває content;
- labels не обрізають критичні значення;
- product actions доступні keyboard/touch;
- checkout links лишаються видимими тільки у verified state;
- demo banner і validations не зникають на mobile.

## 14. Implementation contract

- Tokens оголошуються один раз у `src/app/globals.css`.
- Components не використовують hard-coded brand colors поза tokens.
- Shared primitives не мають Silpo business logic.
- Domain states передаються як typed props, а не виводяться з випадкової copy.
- Component tests перевіряють behavior/roles/text, а не private DOM structure.
- Visual зміна оновлює цей документ у тому самому commit, якщо змінює правило, а не одноразову деталь.

## 15. Посилання

- [Продуктова специфікація](./product-spec.md)
- [Архітектура проєкту](./project-architecture.md)
- [Архітектура агента](./agent-architecture.md)
- [Задачі](./tasks.md)
- [silpo.ua](https://silpo.ua/)
