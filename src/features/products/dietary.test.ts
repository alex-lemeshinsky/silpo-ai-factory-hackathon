import { describe, expect, it } from "vitest";

import { isDietaryCompatible } from "@/features/products/dietary";
import { ProductCandidateSchema, type ProductCandidate } from "@/features/shared/contracts";

function product(name: string): ProductCandidate {
  return ProductCandidateSchema.parse({
    productId: `p-${name}`,
    externalProductId: 1,
    slug: "slug",
    name,
    imageUrl: null,
    price: 10,
    specialPrice: null,
    available: true,
    stock: 5,
    step: 1,
    displayRatio: 1,
    nutritionStatus: "insufficient",
    nutrition: null,
    promotions: [],
  });
}

describe("isDietaryCompatible", () => {
  it("accepts everything when no restriction is declared", () => {
    expect(isDietaryCompatible(product("Молоко 2,5%"), [])).toBe(true);
  });

  it("excludes a product matching a declared restriction", () => {
    expect(isDietaryCompatible(product("Молоко 2,5% 900 г"), ["lactose-free"])).toBe(false);
    expect(isDietaryCompatible(product("Масло вершкове 82,5%"), ["lactose-free"])).toBe(false);
    expect(isDietaryCompatible(product("Напій вівсяний 1 л"), ["lactose-free"])).toBe(true);
  });

  it("applies every declared restriction, not just the first", () => {
    const restrictions = ["lactose-free", "nut-free"];
    expect(isDietaryCompatible(product("Паста горіхова 200 г"), restrictions)).toBe(false);
    expect(isDietaryCompatible(product("Вода негазована 1,5 л"), restrictions)).toBe(true);
  });

  it("ignores a restriction key it does not recognize", () => {
    expect(isDietaryCompatible(product("Молоко 2,5%"), ["low-fodmap"])).toBe(true);
  });

  it("enforces vegetarian and vegan restrictions including meat apostrophe variants", () => {
    expect(isDietaryCompatible(product("Філе куряче охолоджене"), ["vegetarian"])).toBe(false);
    expect(isDietaryCompatible(product("М'ясо свинне гуляш"), ["vegetarian"])).toBe(false);
    expect(isDietaryCompatible(product("М’ясо яловиче"), ["vegetarian"])).toBe(false);
    expect(isDietaryCompatible(product("Сир твердий 45%"), ["vegetarian"])).toBe(true);

    expect(isDietaryCompatible(product("Сир твердий 45%"), ["vegan"])).toBe(false);
    expect(isDietaryCompatible(product("Масло вершкове 82,5%"), ["vegan"])).toBe(false);
    expect(isDietaryCompatible(product("Мед натуральний квітковий"), ["vegan"])).toBe(false);
    expect(isDietaryCompatible(product("Яйця курячі С0"), ["vegan"])).toBe(false);
    expect(isDietaryCompatible(product("Тофу класичний"), ["vegan"])).toBe(true);
  });

  it("enforces no-added-sugar, gluten-free, and nut-free restrictions", () => {
    expect(isDietaryCompatible(product("Йогурт з цукром 1.5%"), ["no-added-sugar"])).toBe(false);
    expect(isDietaryCompatible(product("Чай трав'яний"), ["no-added-sugar"])).toBe(true);

    expect(isDietaryCompatible(product("Хліб пшеничний тостовий"), ["gluten-free"])).toBe(false);
    expect(isDietaryCompatible(product("Макарони спагеті"), ["gluten-free"])).toBe(false);
    expect(isDietaryCompatible(product("Рис круглозернистий"), ["gluten-free"])).toBe(true);

    expect(isDietaryCompatible(product("Арахіс солений"), ["nut-free"])).toBe(false);
    expect(isDietaryCompatible(product("Кеш'ю сирий"), ["nut-free"])).toBe(false);
    expect(isDietaryCompatible(product("Яблуко Голден"), ["nut-free"])).toBe(true);
  });
});
