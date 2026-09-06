const KYIV_TIME_ZONE = "Europe/Kyiv";

const hryvnia = new Intl.NumberFormat("uk-UA", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const plural = new Intl.PluralRules("uk-UA");
const day = new Intl.DateTimeFormat("uk-UA", {
  timeZone: KYIV_TIME_ZONE,
  day: "numeric",
  month: "long",
});
const time = new Intl.DateTimeFormat("uk-UA", {
  timeZone: KYIV_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
});

export function formatHryvnia(value: number): string {
  return `${hryvnia.format(value)} ₴`;
}

export function pluralizeUk(count: number, forms: [string, string, string]): string {
  const category = plural.select(count);
  if (category === "one") {
    return forms[0];
  }
  if (category === "few") {
    return forms[1];
  }
  return forms[2];
}

export function formatDay(iso: string): string {
  return day.format(new Date(iso));
}

export function formatSlot(startsAt: string, endsAt: string): string {
  return `${time.format(new Date(startsAt))}–${time.format(new Date(endsAt))}, ${day.format(new Date(startsAt))}`;
}
