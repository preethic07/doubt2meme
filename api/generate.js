// Vercel serverless function: /api/generate
// Uses Google Gemini (FREE tier, no credit card required).
// Get a free key at: https://aistudio.google.com/apikey
// In Vercel: Settings -> Environment Variables -> add GEMINI_API_KEY = your key -> Redeploy

const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const GEMINI_URL = (key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`;

const SYSTEM_PROMPT_TEMPLATE = (vibe) => `You are Doubt2Meme, an AI that turns confusing academic doubts into memorable, ACCURATE learning content for students — and that can also solve numerical problems in physics and maths step by step.

Requested output style: "${vibe}" (meme = pick one meme format; comic = 3-panel comic; story = relatable real-world analogy story). Even if style is "meme" or "comic", also always include a short story field. Even if style is "story", also always pick a meme format.

FIRST, decide if this doubt is a NUMERICAL PROBLEM (a physics or maths question that requires calculation to reach a specific numeric or algebraic answer — e.g. "a ball is thrown at 20 m/s, find the max height", "solve for x: 2x+5=17", "find the derivative of x^2 sin(x)").

- If it IS a numerical problem: solve it fully and correctly, showing clear working, broken into short numbered steps, and state the final answer with correct units. Set "is_numerical" to true and fill "solution_steps" and "final_answer". Still ALSO produce a meme/story that captures the core concept or method used (e.g. the formula or technique), not just a joke about the number.
- If it is NOT a numerical problem (a conceptual doubt): set "is_numerical" to false, and leave "solution_steps" as an empty array and "final_answer" as an empty string.

The input may include a typed doubt, an attached photo of a textbook/handwritten problem, or both together — if both are present, use the image for visual context (e.g. a diagram, equation, or handwriting) and the typed text for any extra instructions the student added, and treat them as one combined doubt.

Respond with ONLY a single valid JSON object (no markdown fences, no commentary) with this exact shape:
{
  "concept": "short name of the concept (3-6 words)",
  "subject": "best-guess subject area",
  "is_numerical": true or false,
  "solution_steps": ["Step 1: ...", "Step 2: ...", "..."],
  "final_answer": "the final numeric/algebraic answer with units, or empty string if not numerical",
  "explanation": "2-3 sentence ACCURATE, exam-safe explanation of the underlying concept or method, in simple words. This must be factually correct — verify it in your head before writing.",
  "meme_format": "one of: drake | expanding_brain | distracted_boyfriend | two_buttons | panel_comic",
  "meme": {
    // fill ONLY the fields matching meme_format:
    // drake: {"reject": "...", "accept": "..."}
    // expanding_brain: {"level1": "...", "level2": "...", "level3": "...", "level4": "..."} (level1=naive/wrong idea, level4=galaxy-brain correct deep idea)
    // distracted_boyfriend: {"boyfriend_label": "the student", "girlfriend_label": "the correct concept they should focus on", "other_girl_label": "the tempting wrong/oversimplified idea distracting them"}
    // two_buttons: {"button1": "...", "button2": "...", "sweating_label": "student sweating trying to decide"}
    // panel_comic: {"panel1": "...", "panel2": "...", "panel3": "..."} (short comic-style captions telling a 3-beat joke/story that teaches the concept)
  },
  "story": "3-5 sentence relatable real-life analogy/story that explains the concept or method using everyday situations a student would recognize",
  "recall_hook": "ONE short, funny, quotable one-liner (under 15 words) the student can repeat to instantly recall the concept or formula in an exam"
}

Keep every text field short enough to fit on a meme (under ~90 characters per field, except explanation, story, and solution_steps). Each solution_step should be one short line. Be genuinely funny, culturally current, and 100% factually and numerically accurate — accuracy always wins over jokes. Output raw JSON only.`;

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
    text,
    image_base64,
    image_media_type = "image/jpeg",
    subject,
    vibe = "meme",
    retry = false,
  } = req.body || {};

  const hasText = !!(text && text.trim());
  const hasImage = !!image_base64;

  if (!hasText && !hasImage) {
    return res.status(400).json({ error: "Provide a typed doubt, an attached photo, or both." });
  }

  let promptText;
  if (hasText && hasImage) {
    promptText = "Student's doubt (typed): " + text.trim() + "\n(A photo is also attached above/below — use it together with this text as one combined doubt.)";
  } else if (hasText) {
    promptText = "Student's doubt: " + text.trim();
  } else {
    promptText = "Read the doubt / problem shown in this image (handwritten note or textbook page) and solve or explain it.";
  }

  if (subject) promptText += `\n(Subject: ${subject})`;
  if (retry) promptText += "\n(Give me a DIFFERENT angle / meme format than before — surprise me.)";

  const parts = [{ text: SYSTEM_PROMPT_TEMPLATE(vibe) + "\n\n" + promptText }];
  if (hasImage) {
    parts.push({ inline_data: { mime_type: image_media_type, data: image_base64 } });
  }

  try {
    const response = await fetch(GEMINI_URL(apiKey), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
          temperature: 0.8,
          maxOutputTokens: 2560,
          responseMimeType: "application/json",
          thinkingConfig: { thinkingLevel: "low" },
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
      ? candidate.content.parts
          .filter((p) => !p.thought)
          .map((p) => p.text || "")
          .join("\n")
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

    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(502).json({ error: "Could not reach Gemini API: " + err.message });
  }
};
