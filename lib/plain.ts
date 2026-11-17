// "Speak plainly." The rules go into the system prompt; this file checks the result.
// The check is deliberately narrow: ALL-CAPS abbreviations that the reply never explains.
// It feeds the next turn's prompt instead of spending an extra model call.

export const PLAIN_TALK_RULES = `Write for a busy engineer who did not watch you work:
- First sentence: the answer or the outcome. Details after, only if they help.
- Reply in the user's language. Short sentences, everyday words. No filler, hype, or emoji headings.
- No unexplained jargon or abbreviations (SpaceX rule: acronyms seriously suck). The first time a term the user may not know appears, explain it in a few plain words, e.g. "worktree (a separate checkout of the repo)". Never invent abbreviations.
- Keep an established English technical term when it is more precise than a translation (flaky test, fixture, mock, assertion, race condition, rollback, regression); don't force-translate it, and don't mix languages beyond that.
- Say what you did, what you did not do, and what you did not verify. Never claim a test passed unless you ran it.
- Commands in code blocks, paths in backticks. A short list or table beats a long paragraph; no headings for short answers.`;

const BUILTIN_ALLOW = new Set(
  (
    "API APIS URL URLS URI HTTP HTTPS JSON YAML TOML XML HTML CSS JS TS JSX TSX SQL CSV PDF PNG JPG JPEG GIF SVG UTF ASCII " +
    "CPU GPU RAM SSD OS ID IDS UI UX CLI GUI IDE SDK PR PRS CI CD DNS IP TCP UDP SSH TLS SSL VPN LAN USB AI LLM OK " +
    "KB MB GB TB AM PM UTC GMT EOF README TODO FIXME MIT GPL BSD WSL GNU MACOS IOS NPM PIP UV FAQ ETA PS NB " +
    "E2E QA TDD BDD UAT DOM XPATH REST GRPC JWT OAUTH CORS DB ORM CRUD HTTP2 WS"
  ).split(" "),
);

function stripNonProse(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/(?:[A-Za-z]:)?(?:[\\/][\w.-]+){2,}/g, " ");
}

/**
 * Abbreviations used in `reply` that are neither common, nor used by the user, nor explained.
 * Explained means: `ABC (...)`, `ABC（...）`, `...（ABC）`, `ABC, i.e.`, `ABC 即/是/指`.
 */
export function unexplainedAcronyms(reply: string, userText = "", extraAllow: string[] = []): string[] {
  const prose = stripNonProse(reply);
  const allow = new Set([...BUILTIN_ALLOW, ...extraAllow.map((a) => a.toUpperCase())]);
  const userWords = new Set((userText.match(/[A-Za-z][A-Za-z0-9]+/g) ?? []).map((w) => w.toUpperCase()));
  const found = new Set<string>();
  for (const m of prose.matchAll(/(?<![A-Za-z0-9_-])([A-Z][A-Z0-9]{1,9})s?(?![A-Za-z0-9_-])/g)) {
    const word = m[1];
    if (/^\d|^[A-Z]\d+$/.test(word)) continue; // P0, H2, V8
    if (allow.has(word) || userWords.has(word)) continue;
    const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const explained = new RegExp(
      `${esc}s?\\s*[（(]|[（(][^）)]*\\b${esc}\\b[^）)]*[）)]|${esc}s?\\s*[,，]?\\s*(i\\.e\\.|即|是指|指的是|是一种|也就是)`,
    ).test(prose);
    if (!explained) found.add(word);
  }
  return [...found];
}
