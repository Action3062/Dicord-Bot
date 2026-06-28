export const ticketCategories = [
  {
    id: "login",
    label: "Login / Zugang",
    channelPrefix: "login",
    description: "Probleme mit Login, Account oder Freischaltung.",
    keywords: ["login", "zugang", "account", "passwort", "password", "freischaltung", "einloggen"]
  },
  {
    id: "zahlung",
    label: "Zahlung",
    channelPrefix: "zahlung",
    description: "Fragen zu Zahlung, Laufzeit, Rechnung oder Verlaengerung.",
    keywords: ["zahlung", "bezahlen", "laufzeit", "rechnung", "crypto", "bitcoin", "azteco", "verlaengerung"]
  },
  {
    id: "stream",
    label: "Stream-Probleme",
    channelPrefix: "stream",
    description: "Buffering, Qualitaet, Wiedergabe oder Transcoding.",
    keywords: ["stream", "buffer", "ruckelt", "qualitaet", "quality", "wiedergabe", "transcoding", "lade"]
  },
  {
    id: "app",
    label: "App-Hilfe",
    channelPrefix: "app",
    description: "Einrichtung und Bedienung von Jellyfin Apps.",
    keywords: ["app", "android", "ios", "tv", "fire", "stick", "browser", "einrichtung"]
  },
  {
    id: "medienwunsch",
    label: "Medienwunsch",
    channelPrefix: "wunsch",
    description: "Wuensche für Filme, Serien oder Kategorien.",
    keywords: ["wunsch", "film", "serie", "staffel", "medien", "request"]
  },
  {
    id: "sonstiges",
    label: "Sonstiges",
    channelPrefix: "ticket",
    description: "Alles, was nicht in die anderen Kategorien passt.",
    keywords: []
  }
] as const;

export type TicketCategoryId = typeof ticketCategories[number]["id"];

export function getTicketCategory(id: string | null | undefined) {
  return ticketCategories.find((category) => category.id === id) ?? ticketCategories[ticketCategories.length - 1];
}

export function inferTicketCategory(input: string) {
  const normalized = input.toLowerCase();
  const match = ticketCategories
    .map((category) => ({
      category,
      score: category.keywords.filter((keyword) => normalized.includes(keyword)).length
    }))
    .sort((a, b) => b.score - a.score)[0];

  return match && match.score > 0 ? match.category : getTicketCategory("sonstiges");
}
