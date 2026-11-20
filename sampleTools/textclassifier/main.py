import json
import os

import requests
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI()
load_dotenv()
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-flash-lite-latest")
GEMINI_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"

CATEGORIES_ENV = os.getenv("CATEGORIES")
if not CATEGORIES_ENV:
    raise RuntimeError("CATEGORIES environment variable is not set")
CATEGORIES = [c.strip() for c in CATEGORIES_ENV.split(",") if c.strip()]


class ClassificationRequest(BaseModel):
    text: str


@app.get("/")
async def health():
    return {"status": "ok", "model": GEMINI_MODEL, "categories": CATEGORIES}


@app.post("/run")
async def classify(req: ClassificationRequest):
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="Text cannot be empty")
    if not GEMINI_API_KEY:
        raise HTTPException(status_code=500, detail="GEMINI_API_KEY is not set")

    prompt = (
        f"Classify the text into exactly one of these categories: {', '.join(CATEGORIES)}.\n"
        "Also give a confidence between 0 and 1 and a one sentence reason.\n"
        f"Text: {req.text}"
    )
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0,
            "responseMimeType": "application/json",
            "responseSchema": {
                "type": "OBJECT",
                "properties": {
                    "closest_category": {"type": "STRING", "enum": CATEGORIES},
                    "confidence": {"type": "NUMBER"},
                    "reason": {"type": "STRING"},
                },
                "required": ["closest_category", "confidence", "reason"],
            },
        },
    }

    try:
        response = requests.post(
            GEMINI_URL,
            headers={"x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json"},
            data=json.dumps(body),
            timeout=20,
        )
        response.raise_for_status()
        text = response.json()["candidates"][0]["content"]["parts"][0]["text"]
        result = json.loads(text)
    except (requests.exceptions.RequestException, KeyError, IndexError, ValueError) as e:
        raise HTTPException(status_code=502, detail=f"Gemini call failed: {e}")

    if result.get("closest_category") not in CATEGORIES:
        result["closest_category"] = CATEGORIES[-1]
    return result
