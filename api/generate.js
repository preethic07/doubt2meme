// Vercel serverless function: /api/generate
// Uses Google Gemini (FREE tier, no credit card required) instead of Anthropic.
// Get a free key at: https://aistudio.google.com/apikey
// In Vercel: Settings -> Environment Variables -> add GEMINI_API_KEY = your key -> Redeploy
//
// PICTORIAL MEMES (new): after Gemini writes the captions, we caption a REAL meme
// template image via the Imgflip API (https://imgflip.com/api) and return its image
// URL as `meme_image_url`. This needs two more env vars in Vercel:
//   IMGFLIP_USERNAME = a dedicated Imgflip account username (make a new one, not personal)
//   IMGFLIP_PASSWORD = that account's password
// If those aren't set, or the Imgflip call fails for any reason, we simply skip
// `meme_image_url` and the frontend falls back to the existing styled mockup — nothing
// breaks either way.

const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const GEMINI_URL = (key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`;

// Which real Imgflip template to search for, per meme_format.
// panel_comic has no good single-template match, so it's intentionally left out —
// it keeps using the existing 3-panel CSS render.
const TEMPLATE_SEARCH_NAMES = {
  drake: ["Drake Hotline Bling"],
  expanding_brain: ["Expanding Brain", "Four Brain", "Galaxy Brain"],
  distracted_boyfriend: ["Distracted Boyfriend"],
  two_buttons: ["Two Buttons"],
};

// In-memory cache so a warm serverless instance doesn't refetch the template list
// on every single request.
let templateCache = null;
let templateCacheAt = 0;
const TEMPLATE_CACHE_MS = 30 * 60 * 1000; // 30 minutes

async function getTemplates() {
  const now = Date.now();
  if (templateCache && now - templateCacheAt < TEMPLATE_CACHE_MS) return templateCache;
  const resp = await fetch("https://api.imgflip.com/get_memes");
  const data = await resp.json();
  if (!data || !data.success) throw new Error("Could not fetch Imgflip template list");
  templateCache = data.data.memes;
  templateCacheAt = now;
  return templateCache;
}

function findTemplate(memes, names) {
  for (const name of names) {
    const hit = memes.find((m) => m.name.toLowerCase() === name.toLowerCase());
    if (hit) return hit;
  }
  for (const name of names) {
    const hit = memes.find((m) => m.name.toLowerCase().includes(name.toLowerCase()));
    if (hit) return hit;
  }
  return null;
}

// Map each meme_format's fields onto the template's text boxes, in the order
// Imgflip expects them (top-to-bottom / left-to-right as drawn on the template).
// Box order on Imgflip's templates isn't formally documented per-template, so if a
// caption lands in an unexpected spot after you deploy, this ordering is the first
// thing to tweak.
function fieldsToBoxes(format, meme) {
  if (format === "drake") return [meme.reject, meme.accept];
  if (format === "expanding_brain") return [meme.level1, meme.level2, meme.level3, meme.level4];
  if (format === "distracted_boyfriend") return [meme.boyfriend_label, meme.girlfriend_label, meme.other_girl_label];
  if (format === "two_buttons") return [meme.button1, meme.button2, meme.sweating_label];
  return null;
}

async function captionMemeImage(format, meme) {
  const username = process.env.IMGFLIP_USERNAME;
  const password = process.env.IMGFLIP_PASSWORD;
  if (!username || !password) return null; // not configured — skip silently

  const searchNames = TEMPLATE_SEARCH_NAMES[format];
  if (!searchNames) return null; // e.g. panel_comic — no template mapping

  const boxTexts = fieldsToBoxes(format, meme);
  if (!boxTexts || boxTexts.some((t) => !t)) return null;

  const memes = await getTemplates();
  const template = findTemplate(memes, searchNames);
  if (!template) return null;

  // Only caption if the template's real box count matches what we're sending —
  // mismatched counts are how captions end up in the wrong place.
  if (template.box_count !== boxTexts.length) return null;

  const form = new URLSearchParams();
  form.set("template_id", template.id);
  form.set("username", username);
  form.set("password", password);
  boxTexts.forEach((text, i) => {
    form.set(`boxes[${i}][text]`, text);
  });

  const resp = await fetch("https://api.imgflip.com/caption_image", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const data = await resp.json();
  if (!data || !data.success) return null;
  return data.data.url;
}

const SYSTEM_PROMPT_TEMPLATE = (vibe) => `You are Doubt2Meme, an AI that turns confusing academic doubts into memorable, ACCURATE learning content for students.

Requested output style: "${vibe}" (meme = pick one meme format; comic = 3-panel comic; story = relatable real-world analogy story). Even if style is "meme" or "comic", also always include a short story field. Even if style is "story", also always pick a meme format.

Respond with ONLY a single valid JSON object (no markdown fences, no commentary) with this exact shape:
{
  "concept": "short name of the concept (3-6 words)",
  "subject": "best-guess subject area",
  "explanation": "2-3 sentence ACCURATE, exam-safe explanation in simple words. This must be factually correct — verify it in your head before writing.",
  "meme_format": "one of: drake | expanding_brain | distracted_boyfriend | two_buttons | panel_comic",
  "meme": {
    // fill ONLY the fields matching meme_format:
    // drake: {"reject": "...", "accept": "..."}
    // expanding_brain: {"level1": "...", "level2": "...", "level3": "...", "level4": "..."} (level1=naive/wrong idea, level4=galaxy-brain correct deep idea)
    // distracted_boyfriend: {"boyfriend_label": "the student", "girlfriend_label": "the correct concept they should focus on", "other_girl_label": "the tempting wrong/oversimplified idea distracting them"}
    // two_buttons: {"button1": "...", "button2": "...", "sweating_label": "student sweating trying to decide"}
    // panel_comic: {"panel1": "...", "panel2": "...", "panel3": "..."} (short comic-style captions telling a 3-beat joke/story that teaches the concept)
  },
  "story": "3-5 sentence relatable real-life analogy/story that explains the concept using everyday situations a student would recognize",
  "recall_hook": "ONE short, funny, quotable one-liner (under 15 words) the student can repeat to instantly recall the concept in an exam"
}

Keep every text field short enough to fit on a meme (under ~90 characters per field, except explanation and story). Be genuinely funny, culturally current, and 100% factually accurate — accuracy always wins over jokes. Output raw JSON only.`;

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

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Server misconfigured: GEMINI_API_KEY is not set." });
  }

  const {
    mode = "text",
    text,
    image_base64,
    image_media_type = "image/jpeg",
    subject,
    vibe = "meme",
    retry = false,
  } = req.body || {};

  const parts = [];
  let promptText;

  if (mode === "image") {
    if (!image_base64) return res.status(400).json({ error: "image_base64 is required when mode='image'" });
    promptText = "Read the doubt / concept shown in this image (handwritten note or textbook page). Then follow the system instructions.";
  } else {
    if (!text || !text.trim()) return res.status(400).json({ error: "text is required when mode='text'" });
    promptText = "Student's doubt: " + text.trim();
  }

  if (subject) promptText += `\n(Subject: ${subject})`;
  if (retry) promptText += "\n(Give me a DIFFERENT angle / meme format than before — surprise me.)";

  // Gemini takes the system instructions and user text together in "parts"
  parts.push({ text: SYSTEM_PROMPT_TEMPLATE(vibe) + "\n\n" + promptText });
  if (mode === "image") {
    parts.push({ inline_data: { mime_type: image_media_type, data: image_base64 } });
  }

  try {
    const response = await fetch(GEMINI_URL(apiKey), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
          temperature: 0.9,
          maxOutputTokens: 1024,
          responseMimeType: "application/json",
        },
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      const msg = (data && data.error && data.error.message) || "Gemini API error";
      return res.status(response.status).json({ error: msg });
    }

    const candidate = data.candidates && data.candidates[0];
    const rawText = candidate && candidate.content && candidate.content.parts
      ? candidate.content.parts.map((p) => p.text || "").join("\n")
      : "";

    if (!rawText) {
      return res.status(502).json({ error: "Gemini returned no content. Try again." });
    }

    let parsed;
    try {
      parsed = extractJson(rawText);
    } catch (e) {
      return res.status(502).json({ error: "Model returned unparsable JSON. Try again." });
    }

    // Try to turn the captions into a real pictorial meme. This never blocks or
    // fails the response — if anything goes wrong, we just omit meme_image_url
    // and the frontend falls back to the existing styled mockup.
    try {
      const imageUrl = await captionMemeImage(parsed.meme_format, parsed.meme || {});
      if (imageUrl) parsed.meme_image_url = imageUrl;
    } catch (e) {
      // swallow — pictorial meme is a nice-to-have, not a hard requirement
    }

    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(502).json({ error: "Could not reach Gemini API: " + err.message });
  }
};
