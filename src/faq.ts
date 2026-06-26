export type FaqItem = {
  title: string;
  keywords: string[];
  answer: string;
};

export const faqItems: FaqItem[] = [
  {
    title: "Jellyfin Zugang",
    keywords: ["zugang", "account", "jellyfin", "login", "einloggen", "freischalten"],
    answer: "Fuer Jellyfin brauchst du einen aktiven Benutzer. Nutze /usercheck, um deinen Namen zu pruefen, und /payment-link fuer die Zahlungsseite."
  },
  {
    title: "Zahlung",
    keywords: ["zahlung", "bezahlen", "crypto", "bitcoin", "azteco", "rechnung", "invoice"],
    answer: "Zahlungen laufen ueber die Zahlungsseite. Nach einer bestaetigten Zahlung verlaengert die API den Jellyfin-Zugang automatisch."
  },
  {
    title: "Support",
    keywords: ["support", "hilfe", "problem", "fehler", "geht nicht", "kaputt"],
    answer: "Beschreibe bitte kurz dein Geraet, die App, deinen Jellyfin-Benutzernamen und was genau passiert. Ein Support-Mitglied schaut dann rein."
  },
  {
    title: "Passwort",
    keywords: ["passwort", "password", "reset", "vergessen"],
    answer: "Wenn dein Passwort nicht mehr geht, oeffne ein Support-Ticket oder markiere das Support-Team. Teile dein Passwort niemals im Chat."
  },
  {
    title: "Streams",
    keywords: ["stream", "buffer", "ruckelt", "transcoding", "quality", "qualitaet"],
    answer: "Wenn Streams ruckeln, teste zuerst eine niedrigere Qualitaet oder eine offizielle Jellyfin-App. Nenne dem Support danach Geraet, App und Titel."
  }
];

export function listFaqTopics() {
  return faqItems.map((item) => item.title);
}

export function searchFaqItems(input: string, limit = 8) {
  const normalized = input.toLowerCase().trim();
  const scored = faqItems.map((item) => {
    if (!normalized) return { item, score: 1 };
    const titleScore = item.title.toLowerCase().includes(normalized) ? 3 : 0;
    const keywordScore = item.keywords.filter((keyword) => keyword.includes(normalized) || normalized.includes(keyword)).length;
    return { item, score: titleScore + keywordScore };
  });

  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title))
    .slice(0, limit)
    .map((entry) => entry.item);
}

export function answerQuestion(input: string) {
  const normalized = input.toLowerCase();
  const exact = faqItems.find((item) => item.title.toLowerCase() === normalized);
  if (exact) return exact;

  const scored = faqItems.map((item) => ({
    item,
    score: item.keywords.filter((keyword) => normalized.includes(keyword)).length
  })).sort((a, b) => b.score - a.score);

  const best = scored[0];
  return best && best.score > 0 ? best.item : undefined;
}
