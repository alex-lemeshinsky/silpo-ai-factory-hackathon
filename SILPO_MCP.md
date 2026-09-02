# Офіційний MCP «Сільпо»

> Локальна довідка, укладена з [офіційної документації](https://ai-factory.silpo.ua/docs/mcp) 2 вересня 2026 року. Для актуальних назв tools, параметрів і JSON Schema завжди викликайте `tools/list` після авторизації.

## Що це і навіщо

Офіційний MCP-сервер «Сільпо» надає MCP-сумісним AI-клієнтам доступ до каталогу, кошика, замовлень, лояльності й доставки від імені авторизованого гостя.

| Властивість | Значення |
| --- | --- |
| Endpoint | `https://mcp.silpo.ua/mcp` |
| Транспорт | Streamable HTTP |
| Авторизація | OAuth 2.1, Authorization Code + PKCE |
| Кількість tools | 40 |

Усі tools потребують авторизації. Tools з позначкою `cart` потребують контексту кошика (`branchId`, `deliveryType`, `timeslot`), який отримується через `silpo_get_my_shopping_cart` → `silpo_get_shopping_cart_by_id`. Позначка `write` означає зміну даних.

## Швидкий старт

```json
{
  "mcpServers": {
    "silpo": {
      "url": "https://mcp.silpo.ua/mcp"
    }
  }
}
```

Під час першого підключення клієнт відкриє браузер для входу в акаунт «Сільпо».

### Підключення клієнтів

| Клієнт | Налаштування |
| --- | --- |
| Claude Desktop | Додайте URL до `mcpServers` у конфігурації. |
| Claude Code | `claude mcp add --transport http silpo https://mcp.silpo.ua/mcp` |
| Cursor | Додайте URL у налаштування MCP-серверів. |
| Kiro CLI | Додайте URL до `mcpServers` у конфігурації. |

### TypeScript SDK

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(
  new URL("https://mcp.silpo.ua/mcp"),
  { authProvider: mySilpoAuthProvider },
);

const client = new Client(
  { name: "hackathon-agent", version: "0.1.0" },
  { capabilities: {} },
);
await client.connect(transport);
const { tools } = await client.listTools();
```

### Vercel AI SDK

```ts
import { createMCPClient } from "@ai-sdk/mcp";

const mcp = await createMCPClient({
  transport: {
    type: "http",
    url: "https://mcp.silpo.ua/mcp",
    authProvider: mySilpoAuthProvider,
  },
});

const tools = await mcp.tools();
```

### Python SDK

```py
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

async with streamablehttp_client(
    "https://mcp.silpo.ua/mcp",
    auth=my_oauth_provider,
) as (read, write, _):
    async with ClientSession(read, write) as session:
        await session.initialize()
        tools = await session.list_tools()
```

## Як працює авторизація

Сервер застосовує OAuth 2.1 з PKCE. За першого з'єднання клієнт:

1. Отримує `401` і читає метадані з `/.well-known/oauth-authorization-server`.
2. Реєструється через Dynamic Client Registration (`POST /register`).
3. Генерує PKCE-пару та відкриває `/authorize` у браузері.
4. Гість входить на `auth.silpo.ua` за телефоном і OTP або паролем.
5. Клієнт отримує MCP-токен і надсилає його як `Authorization: Bearer <mcp_token>`.

AI-клієнт не отримує Silpo JWT гостя. MCP-токени слід зберігати на бекенді або в secure storage, а не у публічному frontend-коді.

## Доступні tools (40)

### Локація та доставка (6)

| Tool | Призначення |
| --- | --- |
| `silpo_find_address` | Знаходить `lat`/`lng` за текстом адреси. |
| `silpo_get_available_delivery_types` | Повертає доступні типи доставки: `DeliveryHome`, `WideAssortDelivery`, `SelfPickup`, `NovaPoshta`, `B2B`. |
| `silpo_list_branches` | Повертає магазини; підтримує фільтри `hasPickup`, `hasNovaPoshta`. |
| `silpo_get_time_slots` | Повертає слоти доставки для магазину; викликайте після отримання кошика для валідації слота. |
| `silpo_find_nova_poshta_settlements` | Шукає населений пункт Нової Пошти. |
| `silpo_find_nova_poshta_offices` | Повертає відділення й поштомати НП у населеному пункті. |

### Пошук товарів (7)

| Tool | Призначення |
| --- | --- |
| `silpo_find_products_batch` `cart` | Паралельно шукає до 30 товарів; основний tool для списку покупок. |
| `silpo_get_products` `cart` | Пошук із фільтрами категорії, акції, тексту та пагінації. |
| `silpo_get_product_details` `cart` | Повна картка: склад, харчова цінність, атрибути, зображення. |
| `silpo_get_similar_products` `cart` | Схожі або альтернативні товари за slug. |
| `silpo_get_replacements` `cart` | Заміни для недоступних товарів. |
| `silpo_get_my_favorites` | Повертає улюблені товари гостя. |
| `silpo_add_or_update_favorite_products` `write` | Додає або прибирає улюблені товари. |

### Каталог (6)

| Tool | Призначення |
| --- | --- |
| `silpo_get_promotions` `cart` | Активні акції та знижки для магазину. |
| `silpo_get_popular_categories` `cart` | Популярні категорії в магазині. |
| `silpo_get_category` `cart` | Деталі категорії, підкатегорії та кількість товарів. |
| `silpo_get_categories` | Плоский список усіх категорій. |
| `silpo_get_categories_tree` `cart` | Повне дерево категорій і підкатегорій. |
| `silpo_get_product_sets` | Кураторські тематичні та сезонні добірки. |

### Кошик (8)

Рекомендований початок сесії: `silpo_get_my_shopping_cart` → `silpo_get_shopping_cart_by_id` → `silpo_get_time_slots`.

| Tool | Призначення |
| --- | --- |
| `silpo_get_my_shopping_cart` | Повертає ID активного кошика; завжди перший крок. |
| `silpo_create_shopping_cart` `write` | Створює кошик, якщо активного немає; ідемпотентний. |
| `silpo_get_shopping_cart_by_id` | Повертає товари, доставку, слот, суми, валідації, бонуси та checkout-посилання. |
| `silpo_add_or_update_cart_products` `write` | Додає товар або змінює кількість; потрібні `productId`, `companyId`, `branchId`. |
| `silpo_remove_cart_products` `write` | Видаляє задані товари. |
| `silpo_clear_shopping_cart` `write` | Очищає весь кошик. |
| `silpo_update_shopping_cart` `write` | Оновлює доставку, слот, адресу, промокод, оплату або бонуси. |
| `silpo_add_or_update_certificates` `write` | Додає або прибирає подарункові сертифікати. |

### Замовлення (2)

| Tool | Призначення |
| --- | --- |
| `silpo_get_my_online_orders` | Історія онлайн-замовлень із silpo.ua та застосунку. |
| `silpo_get_my_offline_orders` | Історія покупок у фізичних магазинах: чеки, товари, знижки, бонуси. |

### Профіль (4)

| Tool | Призначення |
| --- | --- |
| `silpo_get_my_profile` | Ім'я, телефон, email, дата народження. |
| `silpo_get_my_delivery_addresses` | Збережені адреси доставки. |
| `silpo_get_my_family` | Члени родини: діти й тварини. |
| `silpo_get_my_food_restrictions` | Дієтичні обмеження та харчові вподобання. |

### Лояльність та акції (7)

| Tool | Призначення |
| --- | --- |
| `silpo_get_loyalty_info` | «Власний Рахунок»: номер, статус і баланс балабонусів. |
| `silpo_get_my_coupons` | Доступні купони. |
| `silpo_get_coupon_details` | Умови купона, товари й штрих-код. |
| `silpo_get_my_promos` | Персональні промо-пропозиції. |
| `silpo_get_promo_codes` | Активні промокоди. |
| `silpo_get_my_certificates` | Подарункові сертифікати: код, штрих-код, номінал. |
| `silpo_get_my_premium_subscription` | Статус, дата завершення й переваги Silpo Premium. |

## Створення кошика

Викликайте `silpo_create_shopping_cart` лише коли `silpo_get_my_shopping_cart` повертає `exists: false`. Перед створенням:

```text
1. silpo_find_address
   → latitude, longitude, city, street, houseNumber, district
2. silpo_get_available_delivery_types(latitude, longitude)
   → deliveryType, branchId
   Якщо branchId = null для SelfPickup або NovaPoshta:
   → silpo_list_branches(hasPickup=true або hasNovaPoshta=true)
3. silpo_get_time_slots(branchId, deliveryType)
   → обраний timeslot
```

| Параметр | Тип | Обов'язковий | Джерело |
| --- | --- | --- | --- |
| `addressType` | `house`, `flat`, `office`, `point`, `self-pickup`, `nova-poshta` | Так | Обраний спосіб доставки |
| `latitude`, `longitude` | number | Так | `silpo_find_address` |
| `city`, `street`, `house`, `district` | string | Ні | `silpo_find_address` (`houseNumber` → `house`) |
| `deliveryType` | див. нижче | Так | `silpo_get_available_delivery_types` |
| `timeslot.start`, `timeslot.end` | ISO datetime | Так | `silpo_get_time_slots` |
| `branchId` | string | Так | Типи доставки або список магазинів |

Допустимі `deliveryType`: `SelfPickup`, `DeliveryHome`, `LongDelivery`, `DeliveryExpressByPromise`, `WideAssortDelivery`, `B2B`, `PreOrder`, `NovaPoshta`.

`companyId` передавати не потрібно: сервер використовує `SILPO_DEFAULT_COMPANY_ID`. Після створення перевірте результат через `silpo_get_shopping_cart_by_id`.

## Типові сценарії

### Наповнення кошика зі списку

```text
1. silpo_get_my_shopping_cart → cartId
2. silpo_get_shopping_cart_by_id → branchId, deliveryType, timeslot
3. silpo_get_time_slots → обов'язково валідувати слот
4. silpo_find_products_batch(items[]) → productId, companyId, branchId
5. silpo_add_or_update_cart_products
6. silpo_get_shopping_cart_by_id → перевірити validations[] та checkout links
```

За наявності `loyalty.bonusAvailable > 0` запропонуйте використати балабонуси; за доступного express-варианта покажіть його ціну.

### Зміна адреси доставки

```text
silpo_find_address(text)
→ silpo_get_available_delivery_types(lat, lng)
→ [за потреби] silpo_list_branches / Nova Poshta settlement + office search
→ silpo_get_time_slots(branchId, deliveryType)
→ silpo_update_shopping_cart(...)
→ silpo_get_shopping_cart_by_id
```

### Застосування балабонусів

Після читання кошика, якщо `loyalty.bonusAvailable > 0`, `loyalty.bonusRequested == null` та `loyalty.isEnabled`, спочатку запитайте користувача про згоду, а після неї викличте `silpo_update_shopping_cart(bonusRequested = bonusAvailable)`.

## Помилки та обмеження

| Код / помилка | Дія |
| --- | --- |
| `401 invalid_token` | Оновіть токен через `refresh_token` або повторіть OAuth-потік. |
| `403` | Токен дійсний, але немає доступу до tool. |
| `429` | Застосуйте експоненційний backoff; ліміти діють per-user через `Cookie: mcp-user={userId}`. |
| `-32601 Method not found` | Метод JSON-RPC не підтримується поточною версією. |

## Використання на хакатоні

- Підключайтеся саме до `https://mcp.silpo.ua/mcp`, а не до сторонніх чи неофіційних API.
- У робочому сценарії агента має бути щонайменше один виклик із `tools/list`.
- Підготуйте робочий prototype/demo, де виклик видно у записі екрана, JSON-RPC-лозі або трасі.
- Зберігайте токени на сервері, не у клієнтському коді.

## Джерело

- [Офіційна документація MCP «Сільпо»](https://ai-factory.silpo.ua/docs/mcp)
