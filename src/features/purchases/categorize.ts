const SERVICE_PATTERNS = [
  /пакет/i,
  /послуга доставки/i,
  /доставка/i,
  /прискорення/i,
  /чайові/i,
  /сервісний збір/i,
  /пакування/i,
];

export function isServiceItem(name: string): boolean {
  const trimmed = name.trim();
  return SERVICE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function normalizeItemName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

export function normalizeUnit(unit: string | null | undefined): string | null {
  if (!unit) {
    return null;
  }
  const trimmed = unit.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

interface CategoryRule {
  categoryKey: string;
  patterns: RegExp[];
}

const CATEGORY_RULES: CategoryRule[] = [
  {
    categoryKey: "water",
    patterns: [
      /\bвода\b/i,
      /водичка/i,
      /негазован/i,
      /газован/i,
      /моршинськ/i,
      /боржом/i,
      /поляна квасов/i,
      /микулинецьк/i,
      /\baqua\b/i,
    ],
  },
  {
    categoryKey: "dairy",
    patterns: [
      /молоко/i,
      /кефір/i,
      /йогурт/i,
      /ряжанк/i,
      /сметан/i,
      /сир/i,
      /масло/i,
      /вершк/i,
      /творог/i,
      /бринз/i,
      /сулугуні/i,
    ],
  },
  {
    categoryKey: "eggs",
    patterns: [/яйц/i],
  },
  {
    categoryKey: "bread",
    patterns: [
      /хліб/i,
      /батон/i,
      /багет/i,
      /булочк/i,
      /булк/i,
      /лаваш/i,
      /чіабат/i,
      /круасан/i,
      /тост/i,
    ],
  },
  {
    categoryKey: "coffee",
    patterns: [/кава/i, /арабік/i, /робуст/i, /еспресо/i],
  },
  {
    categoryKey: "tea",
    patterns: [/\bчай\b/i, /чаю/i],
  },
  {
    categoryKey: "grains",
    patterns: [
      /пластівці/i,
      /вівсян/i,
      /гречк/i,
      /рис/i,
      /макарон/i,
      /спагет/i,
      /круп/i,
      /борошн/i,
      /пшон/i,
    ],
  },
  {
    categoryKey: "meat",
    patterns: [
      /м['’]яс/i,
      /курк/i,
      /куряч/i,
      /яловичин/i,
      /свинин/i,
      /філе/i,
      /ковбас/i,
      /сосиск/i,
      /фарш/i,
      /індич/i,
    ],
  },
  {
    categoryKey: "fish",
    patterns: [
      /риб/i,
      /лосос/i,
      /форел/i,
      /оселед/i,
      /тунец/i,
      /тунець/i,
      /креветк/i,
      /скумбрі/i,
    ],
  },
  {
    categoryKey: "produce",
    patterns: [
      /яблук/i,
      /банан/i,
      /апельсин/i,
      /томат/i,
      /помідор/i,
      /огірок/i,
      /картопл/i,
      /цибул/i,
      /моркв/i,
      /лимон/i,
      /зелень/i,
      /капуст/i,
      /ягід/i,
      /ягод/i,
      /фрукт/i,
      /овоч/i,
    ],
  },
  {
    categoryKey: "oil",
    patterns: [/олі[яї]/i, /соняшников/i, /оливков/i],
  },
  {
    categoryKey: "sweets",
    patterns: [/шоколад/i, /цукерк/i, /цукор/i, /торт/i, /вафл/i, /джем/i, /мед/i],
  },
  {
    categoryKey: "snacks",
    patterns: [/чіпс/i, /горіх/i, /сухарик/i, /насінн/i],
  },
  {
    categoryKey: "household",
    patterns: [/мило/i, /папір/i, /серветк/i, /засіб/i, /порошок/i, /шампун/i],
  },
];

export function categorizeItem(name: string): string {
  const normalized = normalizeItemName(name);

  for (const rule of CATEGORY_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(normalized))) {
      return rule.categoryKey;
    }
  }

  return "uncategorized";
}
