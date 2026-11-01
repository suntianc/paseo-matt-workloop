// `req lookup`: given the words of a request, which of this project's
// requirements might it belong to? The answer is evidence, not an owner: a
// candidate list whose every number is computed from the records on disk.
//
// The scoring rule, in one sentence: split the request into Latin words and
// Chinese character bigrams, ask each field of a record how much of itself those
// terms cover, and take the most prominent field. Title and aliases weigh most,
// the summary and refs less; a field half covered already scores 1 on its own.
// There is no model, no randomness, no index and no library — the same records
// and query always produce the same numbers.
import { ambiguousIn, ambiguousRuns } from "./relations.mjs";
import { ledgerDir, readRequirements } from "./store.mjs";

// The three knobs the design keeps: an absolute floor, how far ahead the leader
// must be, and how many candidates come back. They are calibrated by the tests in
// `test/lookup.test.mjs` rather than tuned in place.
export const LOOKUP_DEFAULTS = { threshold: 0.5, lead: 2, limit: 5 };

// How much a match in each field is worth. A word in the name of a requirement is
// the strongest signal there is; prose and citations are supporting evidence.
const FIELD_WEIGHT = { title: 1, alias: 1, summary: 0.6, refs: 0.6 };

const HAN_RUN = /\p{Script=Han}+/gu;
const TERM = /[a-z0-9]+|\p{Script=Han}+/gu;
const LATIN = /^[a-z0-9]/;

const normalise = (text) => String(text ?? "").normalize("NFKC").toLowerCase();

// Latin terms are runs of letters and digits, so "sign-in" yields "sign" and
// "in". Words shorter than three letters ("a", "in", "to", "is") are too common
// to be evidence: one of them would tie a "sign-in" alias to any request that
// happens to contain it, so both the request and the records drop them.
const MIN_LATIN_LENGTH = 3;
function latinTerms(text) {
  return (normalise(text).match(/[a-z0-9]+/g) ?? []).filter((term) => term.length >= MIN_LATIN_LENGTH);
}

// Chinese offers no gaps to split on. A run of characters contributes every
// adjacent pair — "验证码" gives "验证" and "证码" — and a lone character is its
// own term. Bigrams keep compounds together without a segmentation dictionary.
function hanTerms(text) {
  const terms = [];
  for (const run of normalise(text).match(HAN_RUN) ?? []) {
    const chars = [...run];
    if (chars.length === 1) terms.push(chars[0]);
    else for (let i = 0; i < chars.length - 1; i += 1) terms.push(chars[i] + chars[i + 1]);
  }
  return terms;
}

// The request, kept as positions as well as terms: `matched_terms` has to be
// quoted back in the order the user wrote it, and Chinese matches have to be
// reassembled from bigrams into the fragments they came from.
function analyseQuery(query) {
  const text = normalise(query);
  const latin = [];
  const runs = [];
  const latinSeen = new Set();
  for (const match of text.matchAll(TERM)) {
    if (LATIN.test(match[0])) {
      if (match[0].length < MIN_LATIN_LENGTH || latinSeen.has(match[0])) continue;
      latinSeen.add(match[0]);
      latin.push({ term: match[0], at: match.index });
    } else {
      runs.push({ start: match.index, chars: [...match[0]] });
    }
  }
  const han = new Set();
  for (const run of runs) {
    if (run.chars.length === 1) han.add(run.chars[0]);
    else for (let i = 0; i < run.chars.length - 1; i += 1) han.add(run.chars[i] + run.chars[i + 1]);
  }
  return { text, latin, runs, han, latinSet: new Set(latin.map((entry) => entry.term)) };
}

// The summary is the prose under `## Summary`; a record without that heading is
// scored on its whole body rather than on nothing.
function summaryOf(body) {
  const rows = String(body ?? "").replace(/\r\n/g, "\n").split("\n");
  const start = rows.findIndex((row) => /^##\s+summary\b/i.test(row.trim()));
  if (start < 0) return rows.join("\n").trim();
  const end = rows.findIndex((row, index) => index > start && /^#{1,2}\s+\S/.test(row.trim()));
  return rows.slice(start + 1, end < 0 ? rows.length : end).join("\n").trim();
}

// refs hold citations only — ADR numbers, pitfall names, a spec path, CodeGraph
// hints — and their values are still words worth searching.
function flattenRefs(value, out = []) {
  if (value === null || value === undefined) return out;
  if (Array.isArray(value)) {
    for (const item of value) flattenRefs(item, out);
    return out;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) flattenRefs(item, out);
    return out;
  }
  out.push(String(value));
  return out;
}

function fieldsOf(frontmatter, body) {
  const fields = [];
  const add = (kind, text) => {
    const value = String(text ?? "").trim();
    if (!value) return;
    fields.push({
      kind,
      weight: FIELD_WEIGHT[kind],
      text: normalise(value),
      latin: new Set(latinTerms(value)),
      han: new Set(hanTerms(value)),
    });
  };
  add("title", frontmatter.title);
  for (const alias of Array.isArray(frontmatter.aliases) ? frontmatter.aliases : []) add("alias", alias);
  add("summary", summaryOf(body));
  add("refs", flattenRefs(frontmatter.refs).join(" "));
  return fields;
}

// The fragments of the request that a record accounts for, in query order: Latin
// words as written, Chinese runs rebuilt from their matched bigrams.
function matchedTerms(query, fields) {
  const found = query.latin
    .filter(({ term }) => fields.some((field) => field.latin.has(term)))
    .map(({ term, at }) => ({ at, term }));
  for (const run of query.runs) {
    const hits = [];
    if (run.chars.length === 1) {
      const character = run.chars[0];
      if (fields.some((field) => characterHit(field, character))) hits.push(0);
    } else {
      for (let i = 0; i < run.chars.length - 1; i += 1) {
        const bigram = run.chars[i] + run.chars[i + 1];
        if (fields.some((field) => field.han.has(bigram))) hits.push(i);
      }
    }
    // Consecutive bigrams belong to the same fragment: offsets 5 and 6 spell the
    // three characters of "验证码", not two separate pairs.
    for (let i = 0; i < hits.length; i += 1) {
      let end = i;
      while (end + 1 < hits.length && hits[end + 1] === hits[end] + 1) end += 1;
      const first = hits[i];
      const last = hits[end];
      found.push({ at: run.start + first, term: run.chars.slice(first, last + 2).join("") });
      i = end;
    }
  }
  found.sort((a, b) => a.at - b.at);
  const terms = [];
  for (const { term } of found) if (!terms.includes(term)) terms.push(term);
  return terms;
}

// A lone Chinese character is a substring of the field, not one of its terms: it
// is recalled at half a bigram's weight, low enough to be evidence and not
// enough to pass the threshold by itself. Bigram hits are unchanged, so the
// calibrated scores below do not move.
const CHARACTER_WEIGHT = 0.5;

function characterHit(field, term) {
  return term.length === 1 && field.text.includes(term);
}

// The share of a field's own vocabulary that the request covers, doubled so that
// a field half covered scores 1 and a single incidental hit stays small. Taking
// the best field rather than the sum is what makes a short alias a strong signal
// inside a long sentence.
function fieldScore(field, analysed) {
  let hits = 0;
  for (const term of analysed.latinSet) if (field.latin.has(term)) hits += 1;
  for (const term of analysed.han) {
    if (characterHit(field, term)) hits += CHARACTER_WEIGHT;
    else if (field.han.has(term)) hits += 1;
  }
  if (!hits) return 0;
  return Math.min(1, (2 * hits) / (field.latin.size + field.han.size + 1));
}

const collapse = (text) => text.replace(/\s+/g, " ").trim();

// An excerpt of the record's own summary, centred on the first matched term and
// bounded in length. It quotes stored prose; it never composes new prose.
function excerptOf(summary, terms, width = 72) {
  const text = collapse(summary);
  if (!text) return "";
  const lower = normalise(text);
  let at = -1;
  for (const term of terms) {
    const index = lower.indexOf(term);
    if (index >= 0 && (at < 0 || index < at)) at = index;
  }
  if (at < 0) return text.length <= width ? text : `${text.slice(0, width).trimEnd()}…`;
  const start = Math.max(0, at - Math.floor(width / 3));
  const end = Math.min(text.length, start + width);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

// One record against one request: the number, the evidence, and the fields the
// caller quotes.
function scoreRequirement(query, requirement) {
  return scoreAnalysed(analyseQuery(query), requirement);
}

function scoreAnalysed(analysed, requirement) {
  const { frontmatter, body } = requirement;
  const fields = fieldsOf(frontmatter, body);
  const summary = summaryOf(body);

  let score = 0;
  // An exact title or alias is the arrangement the design calls a strongest hit:
  // "用户登录" asked as "用户登录" is not an approximation. A request with no
  // searchable term at all ("a", "!!!") is never a match, exact or not.
  if (analysed.latin.length || analysed.han.size) {
    for (const field of fields) {
      if ((field.kind === "title" || field.kind === "alias") && field.text === collapse(analysed.text)) score = 1;
    }
  }
  for (const field of fields) score = Math.max(score, fieldScore(field, analysed) * field.weight);
  score = Math.round(score * 100) / 100;

  const terms = matchedTerms(analysed, fields);
  const runs = Array.isArray(frontmatter.runs) ? frontmatter.runs : [];
  const last = runs[runs.length - 1];
  return {
    id: frontmatter.id,
    title: frontmatter.title,
    status: frontmatter.status,
    score,
    matched_terms: terms,
    summary_excerpt: excerptOf(summary, terms),
    updated_at: frontmatter.updated_at,
    run_count: runs.length,
    last_delivery: last?.delivery?.state ?? null,
  };
}

// `strong` is a statement about numbers: the leader clears the floor and is at
// least `lead` times the runner-up. `ambiguous` means the numbers do not
// separate; `none` means nothing cleared the floor, which is a fact about
// vocabulary, not about the product.
function decide(candidates, { threshold, lead }) {
  if (!candidates.length || candidates[0].score < threshold) return "none";
  const [, runner] = candidates;
  if (!runner || candidates[0].score >= lead * runner.score) return "strong";
  return "ambiguous";
}

export function lookupRequirements({
  project,
  query,
  threshold = LOOKUP_DEFAULTS.threshold,
  lead = LOOKUP_DEFAULTS.lead,
  limit = LOOKUP_DEFAULTS.limit,
  dir = ledgerDir(project),
  onUnreadable = null,
}) {
  const analysed = analyseQuery(query);
  const requirements = readRequirements(dir);
  // The answer is unchanged, but a record the CLI cannot read is reported to the
  // caller rather than silently dropped: `decision: none` must not be able to stand
  // while a matching record exists and could not be searched.
  for (const requirement of requirements) if (requirement.error) onUnreadable?.(requirement);
  // §6.5: a run two records claim is an ownership question, not a settled fact.
  // The predicate is `relations.mjs`', the same one `list`, `show` and `doctor`
  // mark from; lookup still answers, and only says the ownership is unresolved.
  const ambiguous = ambiguousRuns(requirements);
  const ranked = requirements
    // A record without an id or a title cannot be quoted as a candidate; it is
    // `doctor`'s finding, not a reason to fail the search.
    .filter((requirement) => !requirement.error && typeof requirement.frontmatter?.id === "string" && requirement.frontmatter.title)
    .map((requirement) => {
      const candidate = scoreAnalysed(analysed, requirement);
      return ambiguousIn(requirement.frontmatter, ambiguous).length ? { ...candidate, ambiguous: true } : candidate;
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  // The decision reads the whole ranking, including the runner-up the caller may
  // not see: `--limit` decides how much evidence to print, never whether the
  // leader actually leads.
  return { query, project, decision: decide(ranked, { threshold, lead }), candidates: ranked.slice(0, limit) };
}
