# Doubt2Meme

A working AI app: type or photograph a confusing concept, get back a meme,
comic, story, or full pictorial infographic that explains it — powered by
Google Gemini (free tier).

Also includes: auto subject detection, regional language output (Hindi,
Tamil, Telugu, Kannada, Malayalam), an optional Easy/Medium/Hard recall quiz
per doubt, saved history, and a lightweight in-browser progress tracker —
no login, no database, zero extra cost.

## Deploy this in 4 steps

1. Upload everything in this folder to a new GitHub repo (public or private).
2. Import that repo into Vercel (vercel.com → Add New → Project).
   Framework Preset: **Other**. Leave Build/Output settings empty.
3. Before deploying, add one Environment Variable:
   - Key: `GEMINI_API_KEY`
   - Value: your free key from https://aistudio.google.com/apikey
   - (Optional) `GEMINI_API_KEY_2`, `GEMINI_API_KEY_3`… as quota fallbacks
   - (Optional) `GEMINI_MODEL` to override the default `gemini-3.8-flash`
4. Click Deploy.

That's it — no other setup, no file edits needed. The frontend
(`index.html`) already calls this project's own `/api/generate`
function automatically.

## Files

- `index.html` — the app itself (what visitors see)
- `api/generate.js` — the backend function that talks to Gemini
- `vercel.json`, `package.json` — Vercel project config
- `.env.example` — template for local env vars (never commit real keys)
- `.gitignore` — keeps `.env` files and `.vercel/` out of GitHub

## Test after deploying

Open your live Vercel link, type "What is mitochondria", tap
"Translate my doubt". A meme + explanation should appear in a few seconds.
