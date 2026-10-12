// Only automatic recall filters conversational filler. Explicit searches must
// still find a quoted lyric/title, and an empty explicit query still browses.
const filler = new Set(
  `a an and are as at be been being but by can could did didn do does don for from
   had has have he her here hers herself him his how i if in into is isn it its
   itself just ll m me might more most my myself no nor not of on or our ours out
   re s she should so some t than that the their them then there these they this
   those to too up us ve was we were what when where which while who why will with
   won would you your yours yourself about actually also any anything even get got
   hey hi hello okay ok please really said say something still tell thank thanks
   thing things think very want well yeah yes good morning
   ember valerie softly gently`.split(/\s+/u),
);

/** Bounded lexical cues sampled across the full message, including its end. */
export function recallTerms(text: string): string[] {
  const terms = [
    ...new Set(
      (
        text
          .normalize("NFKC")
          .toLocaleLowerCase("en-US")
          .match(/[\p{L}\p{N}_]+/gu) ?? []
      ).filter((word) => !filler.has(word) && word.length > 1 && Buffer.byteLength(word) <= 64),
    ),
  ];
  const limit = 64;
  if (terms.length <= limit) return terms;
  // Avoid making the first paragraph the only topic in a long message.
  return Array.from(
    { length: limit },
    (_, i) => terms[Math.round((i * (terms.length - 1)) / (limit - 1))],
  ).filter((word): word is string => word !== undefined);
}

export const matchTerms = (terms: string[]) => terms.map((word) => `"${word}"`).join(" OR ");
