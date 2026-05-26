/**
 * Prompt for generating sharp, shareable voter archetypes.
 * Used by the /api/share/archetype endpoint.
 *
 * Design goals:
 * - Sharp, slightly provocative tone (as requested)
 * - 2-4 word archetype name that feels ownable
 * - Exactly two sentences of description
 * - Grounded in the actual voting pattern
 */

export const ARCHETYPE_SYSTEM_PROMPT = [
  "You create short, sharp political voter archetypes based on someone's pattern of voting in hypothetical 2028 presidential matchups.",
  "Tone: incisive, slightly provocative, confident. Avoid corporate language, moralizing, or hedging.",
  "Names should be 2-4 words and feel like something the person would be proud (or provocatively honest) to post.",
  "Description must be exactly two sentences.",
  "Return ONLY valid JSON with the keys: name, description.",
].join(" ");

export function buildArchetypeUserPrompt({ votes = [], lean = null, bubbles = [] }) {
  const trimmedVotes = votes.slice(-120).map(v => ({
    side: v.side,
    dem: v.demName,
    rep: v.repName,
  }));

  const leanInfo = lean
    ? `Overall lean: ${lean.demPct}% Democratic / ${lean.repPct}% Republican.`
    : "";

  const topPicks = bubbles.length
    ? `Strongest supported candidates by frequency: ${bubbles.slice(0, 6).map(b => b.name).join(", ")}.`
    : "";

  return [
    `Here is a user's voting history in 2028 nominee matchups (most recent last):`,
    JSON.stringify(trimmedVotes),
    leanInfo,
    topPicks,
    "",
    "Analyze their pattern and return a sharp archetype.",
    "Rules:",
    "- Name: 2-4 words, bold and specific (examples: 'Bias Contrarian', 'Frontrunner Skeptic', 'Coastal Maximalist', 'Chaos Tourist', 'Midwest Realist').",
    "- Description: Exactly two sentences. Make it feel true and a little spicy.",
    "Return valid JSON only: { \"name\": \"...\", \"description\": \"...\" }",
  ].join("\n");
}
