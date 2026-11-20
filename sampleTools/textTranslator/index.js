import express from "express";
import dotenv from "dotenv";

dotenv.config();
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 80;
const DEFAULT_LANG = process.env.DEFAULT_TARGET_LANG || "en";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-lite-latest";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

app.get("/", (req, res) => res.json({ status: "ok", model: GEMINI_MODEL, target: DEFAULT_LANG }));

app.post("/run", async (req, res) => {
  const { text, targetLang } = req.body || {};
  if (!text) return res.status(400).json({ error: "Missing 'text' field" });
  if (!GEMINI_API_KEY) return res.status(500).json({ error: "GEMINI_API_KEY is not set" });

  const to = targetLang || DEFAULT_LANG;
  const prompt = `Translate the text into the language with code "${to}". Detect the source language.\nText: ${text}`;
  try {
    const r = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              text: { type: "STRING" },
              sourceLang: { type: "STRING" },
            },
            required: ["text", "sourceLang"],
          },
        },
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`Gemini returned ${r.status}`);
    const data = await r.json();
    const out = JSON.parse(data.candidates[0].content.parts[0].text);
    res.json({ text: out.text, sourceLang: out.sourceLang, targetLang: to });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: `Translation failed: ${err.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`Text Translator running on port ${PORT}`);
});
