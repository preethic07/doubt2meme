// Vercel serverless function: /api/generate
// Uses Google Gemini (FREE tier, no credit card required).
// Get a free key at: https://aistudio.google.com/apikey
//
// MULTI-KEY FALLBACK: each free Gemini key has its own daily quota. To survive
// a busy 24hr hackathon, add SEVERAL keys (one per teammate's Google account)
// as separate Vercel env vars named GEMINI_API_KEY, GEMINI_API_KEY_2,
// GEMINI_API_KEY_3, GEMINI_API_KEY_4 ... — this function tries them in order
// and automatically moves to the next one if a key is out of quota (429) or
// otherwise rejected, so the app itself never goes down over a quota issue.
// You only NEED GEMINI_API_KEY to be set; the rest are optional extras.
// In Vercel: Settings -> Environment Variables -> add each key -> Redeploy

const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash"; // gemini-2.5-flash and older are deprecated for new callers as of late 2026

function getApiKeys() {
  const keys = [];
  if (process.env.GEMINI_API_KEY) keys.push(process.env.GEMINI_API_KEY);
  // Support GEMINI_API_KEY_2 through GEMINI_API_KEY_9 as extra fallback keys.
  for (let i = 2; i <= 9; i++) {
    const k = process.env[`GEMINI_API_KEY_${i}`];
    if (k) keys.push(k);
  }
  return keys;
}

// The key is sent in the x-goog-api-key header (not the URL) so it never shows up in logs.
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

// Quiz generation moved out of the main meme/comic/story/infographic prompts and
// into its own on-demand endpoint (see QUIZ_PROMPT below) — the student now picks
// a difficulty AND how many questions they want (5/10/15/20 or a custom number),
// generated fresh each time instead of a fixed 5-per-level batch baked into every
// doubt response. This also lets the quiz range wider than the literal doubt.
const QUIZ_PROMPT = (concept, subject, doubtText, level, count, language) => {
  const LEVEL_STYLE = {
    easy: "basic definition/recall — testing whether the student knows what the concept IS",
    medium: "understanding & comparison — testing whether the student knows HOW it works and how it differs from related ideas",
    hard: "applied — new scenarios, edge cases, and (for technical/programming subjects) short code snippets the student must trace or predict the output of",
  };
  return `You are Doubt2Meme's quiz engine. Generate a ${level.toUpperCase()} difficulty practice quiz.

The student's original doubt was: "${doubtText || concept}"
Concept: ${concept || "(infer from the doubt)"}
Subject: ${subject || "(infer from the doubt)"}

Generate EXACTLY ${count} multiple-choice questions at ${level.toUpperCase()} difficulty (${LEVEL_STYLE[level] || LEVEL_STYLE.medium}).

IMPORTANT — SCOPE: don't just re-ask the exact same doubt ${count} times. Cover the concept the student asked about AND closely related topics within the same subject area a real exam would pair with it, so this is genuine broader practice, not repetition. For example: if the doubt is about a programming concept (e.g. loops, recursion, a data structure), include some "predict the output of this code" questions with a short real code snippet, plus questions on closely related operations/concepts in the same topic area. For a science/math doubt, include related mechanisms, formulas, or adjacent sub-topics a student studying this would also be tested on. Every question must still be squarely within the same subject/chapter — never drift into an unrelated subject.

${PRECISION_INSTRUCTION}

${language && language !== "English" ? `Write every question, option, and "why" in ${language}, adapted naturally for a student who speaks that language (not a literal translation). Keep technical terms and any code snippets in English. Keep JSON field names in English.` : ""}

Respond with ONLY a single valid JSON object (no markdown fences, no commentary) with this exact shape:
{
  "questions": [
    {"question": "the question text (use a markdown-style code block with \\n for newlines if it includes a code snippet)", "options": ["option A", "option B", "option C", "option D"], "correct_index": 0, "why": "one short sentence explaining why that option is correct"}
    // exactly ${count} of these
  ]
}

Each question needs exactly 4 options, exactly one correct. Keep questions and options short and unambiguous. Output raw JSON only.`;
};

// Applies to EVERY subject/topic — the bar for precision must be the same whether the
// doubt is CS, biology, economics, history, or anything else. This is the #1 quality lever.
const PRECISION_INSTRUCTION = `PRECISION IS MANDATORY, FOR EVERY SUBJECT — this is not optional and not topic-specific:
- Never write vague filler like "it helps with various things", "this is important because it works well", or "there are many factors involved". Every sentence must state a specific, concrete, checkable fact: a real number, a real named law/formula/process/date/mechanism/term, or a real named example.
- Use the correct technical vocabulary for the subject (the actual terms a textbook or professor would use), not a dumbed-down paraphrase that loses precision — simplify the EXPLANATION, never the FACTS.
- The worked example (in "example", "tree_steps", or the meme/story) must be a real, internally consistent, correct instance of the concept — real numbers that actually work out, a real chemical equation that actually balances, a real historical date that is actually correct, a real economic scenario with numbers that make sense together. Never a placeholder like "some value" or "a certain event".
- If you are not fully certain a specific fact, number, or date is correct, replace it with a different fact you ARE certain is correct — never guess and present a guess as fact.
- This same standard of specificity applies identically whether the doubt is about data structures, biology, physics, chemistry, economics, history, or anything else.`;

// Governs how LONG/rich each format's output should be. Applied identically across
// meme/comic/story/infographic so a trivial doubt never gets padded and a genuinely
// complex one never gets flattened into one sentence.
const DYNAMIC_COMPLEXITY_INSTRUCTION = `FIRST, silently judge how conceptually complex this doubt is:
- SIMPLE (a single fact, a short definition, one mechanism with no sub-steps): keep output compact — do not pad it.
- MEDIUM (a concept with 2-4 moving parts, or a short process): use a moderate amount of detail.
- COMPLEX (a multi-step process, a concept with several interacting parts, something usually taught over multiple lecture slides): use the fuller end of every range below.
Never inflate a simple doubt to look impressive, and never compress a complex doubt just to be brief — match the depth to the actual concept, every time.`;

// ---------- Prompt builders ----------

// The 4 meme "styles" the user picks on the homepage — a TONE dial, independent of
// meme_format (drake/expanding_brain/etc., which is the visual template). Keeps the
// core "Doubt → Meme" loop simple while still giving a real, distinct feel per style.
const MEME_STYLE_INSTRUCTIONS = {
  relatable: `STYLE = RELATABLE: warm, everyday student-life humor — mess hall, group projects, 2 AM cramming, WiFi dying mid-exam. The kind of joke a student nods along to and says "this is literally me".`,
  savage: `STYLE = SAVAGE: sharp, roast-style, sarcastic, a little brutal — but the roast targets the CONFUSING CONCEPT or a common wrong assumption about it, never the student. Think savage Twitter/X reply energy, not bullying.`,
  movie: `STYLE = MOVIE: frame the joke like an iconic movie/TV trope or trailer beat (e.g. plot-twist reveal, villain-origin-story energy, slow-motion hero-walk) — use GENERIC tropes and describe the vibe in your own words, never name a specific copyrighted film, franchise, or character.`,
  simple: `STYLE = SIMPLE: very short sentences, plain everyday words, zero jargon, gentle and calm humor — written as if explaining to someone hearing this concept for the very first time in their life.`,
};

const MEME_PROMPT = (language, style) => `You are Doubt2Meme, an AI that turns a confusing academic doubt into a proper EDUCATIONAL meme — the humor must come FROM the academic concept itself, never a random unrelated joke.

CRITICAL — ANSWER THE EXACT DOUBT, NOT JUST THE TOPIC: read the student's doubt as literally written. If they asked "why does X happen" the meme must explain WHY, not just define X. If they asked "what's the difference between X and Y" the meme must actually contrast X and Y. Never drift to a generic overview of the general topic when a more specific question was asked — the joke and the explanation must both resolve the SPECIFIC thing the student was confused about.

${MEME_STYLE_INSTRUCTIONS[style] || MEME_STYLE_INSTRUCTIONS.relatable}

${language && language !== "English" ? `Write EVERY text field (explanation, meme text, setup, takeaway, recall_hook, quiz) in ${language}, adapted naturally for a student who speaks that language — NOT a literal word-for-word translation. Keep technical/English terminology (e.g. "Stack", "LIFO", "CPU") in English where translating it would make the concept harder to recognize; blend it naturally into the sentence the way a bilingual student actually talks (e.g. "Stack என்பது ஒரு LIFO data structure."). Keep JSON field names in English.` : ""}

${PRECISION_INSTRUCTION}

${DYNAMIC_COMPLEXITY_INSTRUCTION}


The meme must make the student understand the concept even if they've never studied it, by walking through: a relatable student-life setup → the concept represented correctly inside the joke → a punchline connected to the concept → what it actually means → a memorable takeaway. Allow yourself a slightly longer setup/punchline for a complex concept instead of cramming it into one line.

Respond with ONLY a single valid JSON object (no markdown fences, no commentary) with this exact shape:
{
  "concept": "short name of the concept (3-6 words)",
  "subject": "best-guess subject area",
  "setup": "1-2 sentences setting up a relatable student-life situation that leads into this concept (e.g. 'Every CS student piling plates in the mess hall...')",
  "explanation": "2-3 sentence explanation using specific, technically correct facts and real terminology — not a vague simplification. This must be factually correct — verify it in your head before writing.",
  "meme_format": "one of: drake | expanding_brain | distracted_boyfriend | two_buttons | panel_comic",
  "meme": {
    // fill ONLY the fields matching meme_format:
    // drake: {"reject": "...", "accept": "..."}
    // expanding_brain: {"level1": "...", "level2": "...", "level3": "...", "level4": "..."} (level1=naive/wrong idea, level4=galaxy-brain correct deep idea)
    // distracted_boyfriend: {"boyfriend_label": "the student", "girlfriend_label": "the correct concept they should focus on", "other_girl_label": "the tempting wrong/oversimplified idea distracting them"}
    // two_buttons: {"button1": "...", "button2": "...", "sweating_label": "student sweating trying to decide"}
    // panel_comic: {"panel1": "...", "panel2": "...", "panel3": "..."} (short comic-style captions telling a 3-beat joke/story that teaches the concept)
  },
  "meme_means": "1-2 sentences explicitly decoding 'what the meme means' — tie each side/level of the meme back to the specific concept term it represents, so a first-time reader gets the joke AND the concept",
  "story": "3-5 sentence relatable real-life analogy/story that explains the concept using everyday situations a student would recognize",
  "takeaway": "ONE memorable sentence (under 20 words) summing up the core idea to remember",
  "recall_hook": "ONE short, funny, quotable one-liner (under 15 words) the student can repeat to instantly recall the concept in an exam"
}

Keep meme/setup/meme_means fields punchy (setup and meme fields under ~110 characters each; explanation, story, meme_means can run longer for complex concepts). Be genuinely funny, culturally current, and 100% factually accurate — accuracy always wins over jokes. Output raw JSON only.`;

const COMIC_PROMPT = (language) => `You are Doubt2Meme, an AI that turns a confusing academic doubt into a real explanatory mini-comic — NOT a 2-3 line gag. The comic must progressively TEACH the concept, panel by panel, and stay educational throughout (never drift into an unrelated story).

${language && language !== "English" ? `Write EVERY text field (dialogue, narration, concept_point, takeaway, recall_hook, quiz) in ${language}, adapted naturally for a student who speaks that language — NOT a literal word-for-word translation. Keep technical/English terminology (e.g. "Stack", "LIFO", "CPU") in English where translating it would make the concept harder to recognize, blended naturally into the sentence. Keep JSON field names in English.` : ""}

${PRECISION_INSTRUCTION}

${DYNAMIC_COMPLEXITY_INSTRUCTION}


Decide the right panel count for this doubt's complexity: SIMPLE = 4-5 panels, MEDIUM = 5-6 panels, COMPLEX = 7-8 panels. Do not add filler panels for a simple concept. Follow this general beat structure, compressing or merging beats for simpler concepts:
Panel 1 → student encounters the doubt/problem. Panel 2 → introduce the concept. Panel 3 → explain the first important part. Panel 4 → show how it works (the mechanism). Panel 5 → a relatable concrete example. Panel 6 → clarify a common misunderstanding. Panel 7 → the final "aha" understanding. Panel 8 → memorable takeaway.

Respond with ONLY a single valid JSON object (no markdown fences, no commentary) with this exact shape:
{
  "concept": "short name of the concept (3-6 words)",
  "subject": "best-guess subject area",
  "explanation": "2-3 sentence overview of the concept using specific, technically correct facts and real terminology. Must be factually correct.",
  "panels": [
    {
      "panel_number": 1,
      "scene": "one short sentence describing the visual scene/setting (for a reader to picture it — no image is generated, this is a text description)",
      "characters": ["short names/roles of who's in this panel, e.g. 'Student (Riya)', 'Concept Guide (owl)'"],
      "dialogue": "the actual line(s) of dialogue spoken in this panel, in quotes-style text, short and punchy",
      "narration": "optional short narration/caption box text for this panel (empty string if not needed)",
      "concept_point": "the ONE specific fact/term/step this exact panel is teaching (must be a real, checkable fact, not vague)"
    }
    // repeat for each panel, matching the panel count you chose (4-8 depending on complexity)
  ],
  "takeaway": "ONE memorable sentence (under 20 words) summing up the core idea to remember, matching the final panel",
  "recall_hook": "ONE short, funny, quotable one-liner (under 15 words) the student can repeat to instantly recall the concept in an exam"
}

Every "concept_point" together must add up to a complete, technically correct explanation of the doubt — a student who only reads the concept_points should still learn the real mechanism. Keep dialogue/narration snappy and comic-style, never a wall of text in one panel. Output raw JSON only.`;

const STORY_PROMPT = (language) => `You are Doubt2Meme, an AI that turns a confusing academic doubt into a short but complete educational STORY — not a random tale with academic facts sprinkled in, but a story whose entire arc IS the explanation.

${language && language !== "English" ? `Write EVERY text field (all story sections, takeaway, recall_hook, quiz) in ${language}, adapted naturally for a student who speaks that language — NOT a literal word-for-word translation. Keep technical/English terminology (e.g. "Stack", "LIFO", "CPU") in English where translating it would make the concept harder to recognize, blended naturally into the sentence. Keep JSON field names in English.` : ""}

${PRECISION_INSTRUCTION}

${DYNAMIC_COMPLEXITY_INSTRUCTION}


Decide overall story length by complexity: SIMPLE = roughly 120-200 words total, MEDIUM = roughly 250-400 words total, COMPLEX = roughly 500-700 words total. Do not add unnecessary fictional details just to increase length — every sentence should either move the story or teach the concept.

Respond with ONLY a single valid JSON object (no markdown fences, no commentary) with this exact shape:
{
  "concept": "short name of the concept (3-6 words)",
  "subject": "best-guess subject area",
  "explanation": "2-3 sentence overview of the concept using specific, technically correct facts and real terminology. Must be factually correct.",
  "story_sections": {
    "beginning": "introduce a relatable student situation involving the doubt",
    "problem": "show specifically why the student is confused (the actual point of confusion)",
    "concept_intro": "introduce the academic concept naturally, as the student encounters/learns its name",
    "explanation": "explain the concept step-by-step through the story's action — this is the core teaching section, must be technically precise",
    "example": "a real-life analogy or worked example woven into the story, using real concrete values/specifics wherever appropriate",
    "resolution": "show how the student finally understands the concept, and how that resolves the original problem",
    "takeaway": "end with a concise, precise academic summary the student would write in exam margin notes"
  },
  "recall_hook": "ONE short, funny, quotable one-liner (under 15 words) the student can repeat to instantly recall the concept in an exam"
}

Every section must exist and move the concept forward — never pad "beginning" with generic scene-setting unrelated to the doubt. Output raw JSON only.`;

// The "pictorial infographic" mode: same idea as the ChatGPT-style image the jury showed,
// but we ask Gemini for structured CONTENT ONLY (never pixels), and the frontend renders
// it as a crisp, real-text HTML/CSS card that can be exported to a PNG in-browser.
// This is faster, free, and never garbles text — because no text is ever drawn by an AI image model.
const INFOGRAPHIC_PROMPT = (language) => `You are Doubt2Meme, an AI that turns a student's confusing academic doubt into the content for a single-page visual study infographic (think: a well-designed poster explaining one concept, with a small meme joke at the bottom).

Automatically detect the subject/field yourself from the doubt text (do not assume any specific field).

PRECISION IS THE #1 PRIORITY — more important than brevity or humor. This is a study reference a student will rely on, so:
- Every fact must be technically exact, textbook-grade, and verifiable — never vague, hand-wavy, or "pop-science" phrasing.
- "key_features" must be specific mechanisms or properties (e.g. "O(1) push/pop from the top only" — NOT "it's fast" or "very useful").
- The worked example ("example" or "tree_steps") must use REAL, CONCRETE, internally-consistent values and walk through the ACTUAL mechanics step by step — not generic placeholders like "Step 1", "Step 2" unless the concept truly has no natural example values.
- "operations" must state the real time/space complexity or precise mechanical detail where relevant (e.g. "Push: O(1), adds to top"), not just a one-line vibe.
- "analogy" must map each part of the analogy onto a specific real part of the concept (e.g. name which analogy element = which technical element), not just a loosely-related comparison.
- Never sacrifice correctness for a joke — if being funny would require oversimplifying to the point of being misleading, be accurate first.

${DYNAMIC_COMPLEXITY_INSTRUCTION} A simple concept needs fewer operations/steps and a shorter analogy; a complex one can use the fuller ranges given below — never force a simple concept into a multi-stage diagram it doesn't need.

CARICATURE REQUIREMENT: prefer a friendly educational caricature/character interacting WITH the concept over a plain labeled box. Bad: a box saying "Stack → LIFO". Better: a student placing books one on top of another and trying to remove the top book first, labeled "STACK → LIFO → Last In, First Out". This is why "analogy_characters" and "mascot" below must always describe characters actively DOING something with the concept, not just standing next to a label.

IMPORTANT — pick the right diagram type:
- If the doubt is about a TREE, GRAPH, HEAP, ROTATION, or any concept naturally drawn as connected nodes with parent/child or node-to-node links (e.g. AVL rotation, BST insert, heapify, tree traversal, graph BFS/DFS) — set "is_tree_concept": true and fill "tree_steps" (see below). Leave "structure" and "example" as empty objects {} in that case.
- Otherwise (linear/sequential concepts like linked lists, arrays, stacks, queues, processes, algorithms without branching structure) — set "is_tree_concept": false, leave "tree_steps": [], and fill "structure" and "example" as before.

Respond with ONLY a single valid JSON object (no markdown fences, no commentary) with this EXACT shape:
{
  "concept": "short concept title (2-5 words), e.g. 'AVL Tree LR Rotation'",
  "subject": "best-guess subject area, e.g. 'Data Structures'",
  "key_features": ["3-4 PRECISE technical facts (exact mechanism, complexity, or property — not vague praise), each under 90 characters"],
  "is_tree_concept": false,
  "structure": {
    "caption": "short label for a structure/anatomy diagram of this concept, e.g. 'Structure of a Node'",
    "parts": ["2-4 short labels for the parts/components of the structure, in order, each under 18 characters, e.g. 'Prev', 'Data', 'Next'. Leave as [] if is_tree_concept is true."]
  },
  "example": {
    "caption": "short label for a worked example, e.g. 'Example Walkthrough'",
    "items": ["3-5 short sequential values/steps that walk through one concrete example, each under 14 characters, e.g. '10','20','30' or 'Step 1','Step 2'. Leave as [] if is_tree_concept is true."]
  },
  "tree_steps": [
    // ONLY fill this if is_tree_concept is true. 3-5 steps walking through the exact worked example
    // (e.g. "The Problem", "Step 1: rotate X", "Step 2: rotate Y", "Result"). Each step:
    {
      "label": "short step title, under 30 chars, e.g. 'Step 1: Left rotation on 20'",
      "note": "one short sentence explaining what happens in this step, under 90 chars",
      "tree": {
        // A recursive binary tree node. null means no child. Use REAL example values (numbers/letters),
        // not placeholders. "tag" is optional small annotation (e.g. balance factor like '(-2)' or '(0)').
        // "highlight" is optional: "red" | "gold" | "violet" | "green" to color a node involved in this step's action.
        "value": "30", "tag": "(-2)", "highlight": "red",
        "left": { "value": "20", "tag": "(+1)", "highlight": "gold", "left": { "value": "10", "tag": "(0)", "highlight": null, "left": null, "right": null }, "right": { "value": "25", "tag": "(0)", "highlight": null, "left": null, "right": null } },
        "right": { "value": "40", "tag": "(0)", "highlight": null, "left": null, "right": null }
      }
    }
  ],
  "operations": [
    {"name": "short operation/step name, under 20 chars", "detail": "PRECISE mechanical detail or exact complexity (e.g. 'O(1), adds to top of stack'), under 100 chars"}
  ],
  "analogy": "one short paragraph (2-3 sentences) giving a real-life analogy, but map it PRECISELY: state which analogy element corresponds to which real technical element, so the comparison actually teaches the mechanism rather than just being colorful",
  "analogy_characters": [
    {"emoji": "a single emoji representing one entity/role in the analogy (a person, animal, or object)", "label": "under 16 chars naming this entity"}
    // 3-4 of these, in the order they act in the analogy — these render as a small illustrated cast so the analogy reads like a little comic strip, not just a paragraph.
  ],
  "mascot": {
    "emoji_left": "a single expressive emoji/animal face that fits the subject's personality (e.g. a calm owl for a stable/balanced concept, a confused emoji for a tricky one)",
    "caption_left": "a short witty ONE-LINER (under 55 chars) this mascot 'says' about the topic — playful, not a repeat of the explanation",
    "emoji_right": "a second, different single emoji/animal face reacting to the same topic from a different angle (e.g. relieved, impressed, smug)",
    "caption_right": "a short witty ONE-LINER (under 55 chars) this second mascot 'says' — should read like a punchline/reaction to the left one"
  },
  "common_mistake": {
    "wrong": "one short, specific, REAL misconception students actually have about this exact concept (under 90 chars) — not a made-up strawman",
    "correct": "the precise correction — what's actually true, stated as a concrete technical fact (under 100 chars)",
    "wrong_emoji": "one emoji conveying 'incorrect' for this mistake (e.g. ❌, 🙅, 😵)",
    "correct_emoji": "one emoji conveying 'correct' for the fix (e.g. ✅, 💡, 🎯)"
  },
  "pros": ["2-3 short advantages, each under 60 characters"],
  "cons": ["2-3 short disadvantages/limitations, each under 60 characters"],
  "meme_emoji": "ONE single emoji that best fits the bottom meme joke's mood (e.g. 😹, 🤯, 😵‍💫, 🙃, 😎) — must match meme_caption_top/bottom's tone",
  "meme_caption_top": "short top caption for a relatable meme joke about struggling with / mastering this concept, under 70 characters",
  "meme_caption_bottom": "short bottom caption / punchline for the same joke, under 90 characters",
  "recall_hook": "ONE short, funny, quotable one-liner (under 15 words) to instantly recall the concept in an exam"
}

Include 3-6 items in "operations" and exactly 3-4 items in "analogy_characters". Always fill "common_mistake" with a genuine, specific misconception — never leave it generic ("students get confused") or skip it. The mascot captions, analogy characters, and common_mistake are what make this feel like an illustrated, meme-style poster rather than a plain document — always fill them, for every single topic, regardless of subject. Every tree diagram must be internally consistent — a node's children must actually make sense as a binary tree at each step, and values should stay the SAME real example across all steps (like the AVL rotation walking through one concrete tree). Everything must be 100% factually accurate — verify it in your head before writing; accuracy always wins over jokes. Output raw JSON only.`;

// ---------- In-memory response cache ----------
// Free, zero-setup way to stretch the free Gemini quota: if the exact same
// doubt+mode+vibe+language is requested again (very common during judging/demos,
// where several people retest the same sample doubts), skip the Gemini call
// entirely and reuse the previous result instantly. Lives only in this warm
// serverless instance's memory (resets on cold start) — that's fine, it's a
// bonus optimization on top of the multi-key fallback, not a database.
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const CACHE_MAX_ENTRIES = 200;
const responseCache = new Map(); // key -> { data, expires }

function cacheKeyFor({ mode, text, image_base64, subject, vibe, language, retry, style }) {
  // "retry" deliberately busts the cache — the user explicitly asked for a fresh angle.
  if (retry) return null;
  const bodyPart = mode === "image" ? "img:" + (image_base64 || "").slice(0, 64) : "txt:" + (text || "").trim().toLowerCase();
  return [mode, bodyPart, subject || "", vibe || "meme", language || "English", style || "relatable"].join("|");
}

function getCached(key) {
  if (!key) return null;
  const hit = responseCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    responseCache.delete(key);
    return null;
  }
  return hit.data;
}

function setCached(key, data) {
  if (!key) return;
  if (responseCache.size >= CACHE_MAX_ENTRIES) {
    // drop the oldest entry to keep memory bounded
    const oldestKey = responseCache.keys().next().value;
    if (oldestKey !== undefined) responseCache.delete(oldestKey);
  }
  responseCache.set(key, { data, expires: Date.now() + CACHE_TTL_MS });
}

// ---------- Per-IP rate limiting ----------
// Free, zero-setup protection: caps requests per IP in a rolling window so one
// person mashing the button (accidentally or during judging) can't burn through
// every fallback API key right before your turn to demo. In-memory, resets on
// cold start — that's fine, it's a safety net, not a security boundary.
const RATE_LIMIT_MAX = 10; // requests
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // per 1 minute
const rateLimitLog = new Map(); // ip -> array of request timestamps

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (rateLimitLog.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  timestamps.push(now);
  rateLimitLog.set(ip, timestamps);
  // keep the map from growing forever across many distinct IPs
  if (rateLimitLog.size > 500) {
    const oldestKey = rateLimitLog.keys().next().value;
    if (oldestKey !== undefined) rateLimitLog.delete(oldestKey);
  }
  return timestamps.length > RATE_LIMIT_MAX;
}

function getClientIp(req) {
  const fwd = req.headers && req.headers["x-forwarded-for"];
  if (fwd) return fwd.split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

function extractJson(raw) {
  let cleaned = raw.trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/, "")
    .replace(/```\s*$/, "");
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw e;
  }
}

// Shared multi-key-fallback Gemini caller, used by both the main doubt-generation
// flow and the on-demand quiz endpoint below. Tries each configured key in order,
// moving to the next only on quota/auth errors (429/403) or network failures —
// any other failure is returned immediately since switching keys wouldn't help.
async function callGeminiJSON(apiKeys, parts, maxOutputTokens) {
  const requestBody = JSON.stringify({
    contents: [{ role: "user", parts }],
    generationConfig: {
      // NOTE: no temperature/topP/topK — Google's Gemini 3.x migration guide says to strip them.
      maxOutputTokens,
      responseMimeType: "application/json",
      // Gemini 3.x "thinks" before answering and those thinking tokens count toward
      // maxOutputTokens. "low" keeps responses fast (well under Vercel's time limit)
      // and leaves room for the full JSON so it never gets cut off mid-object.
      ...(MODEL.startsWith("gemini-3") ? { thinkingConfig: { thinkingLevel: "low" } } : {}),
    },
  });

  let lastError = null;
  const RETRYABLE_STATUSES = new Set([429, 403, 503, 500]);
  // A 503 ("model overloaded") is transient — the SAME key often succeeds a
  // moment later, so retry it in place a couple of times (short backoff)
  // before giving up on that key and moving to the next one.
  const OVERLOAD_RETRY_DELAYS_MS = [600, 1400];

  for (let i = 0; i < apiKeys.length; i++) {
    const apiKey = apiKeys[i];
    let attempt = 0;

    while (true) {
      try {
        const response = await fetch(GEMINI_URL, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
          body: requestBody,
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
          const msg = (data && data.error && data.error.message) || "Gemini API error";
          const status = response.status;

          // Overloaded/rate-limited on THIS key: back off and retry the same
          // key a couple of times before moving on — switching keys too
          // eagerly wastes quota on a problem a short wait usually fixes.
          if (status === 503 && attempt < OVERLOAD_RETRY_DELAYS_MS.length) {
            await new Promise((r) => setTimeout(r, OVERLOAD_RETRY_DELAYS_MS[attempt]));
            attempt++;
            continue;
          }

          if (RETRYABLE_STATUSES.has(status) && i < apiKeys.length - 1) {
            lastError = { status, msg };
            break; // move to next key
          }
          return { ok: false, status, error: msg };
        }

        const candidate = data.candidates && data.candidates[0];
        const rawText = candidate && candidate.content && candidate.content.parts
          ? candidate.content.parts.map((p) => p.text || "").join("\n")
          : "";

        if (!rawText) {
          const reason = (candidate && candidate.finishReason) || (data.promptFeedback && data.promptFeedback.blockReason);
          return { ok: false, status: 502, error: "Gemini returned no content" + (reason ? " (" + reason + ")" : "") + ". Try again." };
        }

        let parsed;
        try {
          parsed = extractJson(rawText);
        } catch (e) {
          const cutOff = candidate && candidate.finishReason === "MAX_TOKENS";
          return { ok: false, status: 502, error: cutOff
            ? "The answer was too long and got cut off. Try again or ask a narrower doubt."
            : "Model returned unparsable JSON. Try again." };
        }

        return { ok: true, data: parsed };
      } catch (err) {
        lastError = { status: 502, msg: err.message };
        break; // network/parse failure — move to next key
      }
    }
  }

  return {
    ok: false,
    status: (lastError && lastError.status) || 502,
    error: "All configured API keys failed. Last error: " + ((lastError && lastError.msg) || "unknown"),
  };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  if (isRateLimited(getClientIp(req))) {
    return res.status(429).json({ error: "Too many requests from this device in a short time — please wait a few seconds and try again." });
  }

  // Vercel parses JSON bodies automatically; this is a fallback if it arrives as a string.
  if (typeof req.body === "string") {
    try { req.body = JSON.parse(req.body); } catch (e) { req.body = {}; }
  }

  const apiKeys = getApiKeys();
  if (!apiKeys.length) {
    return res.status(500).json({ error: "Server misconfigured: GEMINI_API_KEY is not set." });
  }

  // ---- On-demand quiz generation (separate lightweight flow) ----
  // The student picks a difficulty + how many questions (5/10/15/20 or custom);
  // this is generated fresh each time rather than baked into every doubt response.
  if (req.body && req.body.quiz_request) {
    const {
      concept = "",
      subject = "",
      doubt = "",
      level = "medium",
      count = 5,
      language = "English",
    } = req.body;

    const quizLevel = ["easy", "medium", "hard"].includes(level) ? level : "medium";
    const quizCount = Math.max(1, Math.min(30, parseInt(count, 10) || 5));

    const quizCacheKey = ["quiz", concept.trim().toLowerCase(), subject, quizLevel, quizCount, language].join("|");
    const cachedQuiz = getCached(quizCacheKey);
    if (cachedQuiz) {
      return res.status(200).json({ ...cachedQuiz, _cached: true });
    }

    const quizPrompt = QUIZ_PROMPT(concept, subject, doubt, quizLevel, quizCount, language);
    const result = await callGeminiJSON(apiKeys, [{ text: quizPrompt }], Math.min(16384, 2048 + quizCount * 300));

    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }

    const quizData = result.data;
    quizData.level = quizLevel;
    quizData.count = quizCount;
    setCached(quizCacheKey, quizData);
    return res.status(200).json(quizData);
  }

  const {
    mode = "text",
    text,
    image_base64,
    image_media_type = "image/jpeg",
    subject,
    vibe = "meme",
    language = "English",
    retry = false,
    style = "relatable", // meme tone: relatable | savage | movie | simple
  } = req.body || {};

  if (mode !== "image" && text && text.trim().length > 600) {
    return res.status(400).json({ error: "That doubt is too long (max 600 characters) — please shorten it so the explanation stays focused." });
  }

  const isInfographic = vibe === "infographic";
  const formatKind = ["meme", "comic", "story", "infographic"].includes(vibe) ? vibe : "meme";
  const memeStyle = ["relatable", "savage", "movie", "simple"].includes(style) ? style : "relatable";

  const cacheKey = cacheKeyFor({ mode, text, image_base64, subject, vibe, language, retry, style: memeStyle });
  const cachedResult = getCached(cacheKey);
  if (cachedResult) {
    return res.status(200).json({ ...cachedResult, _cached: true });
  }

  const parts = [];
  let promptText;

  if (mode === "image") {
    if (!image_base64) return res.status(400).json({ error: "image_base64 is required when mode='image'" });
    // Vercel rejects request bodies over 4.5 MB; the frontend shrinks photos, this is a safety net.
    if (image_base64.length > 4_000_000) return res.status(413).json({ error: "That photo is too large — please try a smaller or cropped image." });
    promptText = "Read the doubt / concept shown in this image (handwritten note or textbook page). Then follow the system instructions.";
  } else {
    if (!text || !text.trim()) return res.status(400).json({ error: "text is required when mode='text'" });
    promptText = "Student's doubt: " + text.trim();
  }

  if (subject) promptText += `\n(Subject: ${subject})`;
  if (retry) promptText += "\n(Give me a DIFFERENT angle / different examples than before — surprise me.)";

  let systemPrompt;
  switch (formatKind) {
    case "infographic":
      systemPrompt = INFOGRAPHIC_PROMPT(language);
      break;
    case "comic":
      systemPrompt = COMIC_PROMPT(language);
      break;
    case "story":
      systemPrompt = STORY_PROMPT(language);
      break;
    default:
      systemPrompt = MEME_PROMPT(language, memeStyle);
  }

  parts.push({ text: systemPrompt + "\n\n" + promptText });
  if (mode === "image") {
    parts.push({ inline_data: { mime_type: image_media_type, data: image_base64 } });
  }

  const result = await callGeminiJSON(apiKeys, parts, 16384);
  if (!result.ok) {
    return res.status(result.status).json({ error: result.error });
  }

  const parsed = result.data;
  parsed.is_infographic = isInfographic;
  parsed.format_kind = formatKind; // additive field: "meme" | "comic" | "story" | "infographic"
  if (formatKind === "meme") parsed.meme_style = memeStyle; // additive: relatable | savage | movie | simple
  setCached(cacheKey, parsed);
  return res.status(200).json(parsed);
};
