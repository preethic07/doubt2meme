# Doubt2Meme

A working AI app: type or photograph a confusing concept, get back a meme,
comic, or story that explains it — powered by Google Gemini (free tier).

## Deploy this in 3 steps

1. Upload everything in this folder to a new GitHub repo (public).
2. Import that repo into Vercel (vercel.com → Add New → Project).
3. Before deploying, add one Environment Variable:
   - Key: `GEMINI_API_KEY`
   - Value: your free key from https://aistudio.google.com/apikey
4. Click Deploy.

That's it — no other setup, no file edits needed. The frontend
(`index.html`) already calls this project's own `/api/generate`
function automatically.

## Files

- `index.html` — the app itself (what visitors see)
- `api/generate.js` — the backend function that talks to Gemini
- `vercel.json`, `package.json` — Vercel project config

## Test after deploying

Open your live Vercel link, type "What is mitochondria", tap
"Translate my doubt". A meme + explanation should appear in a few seconds.
