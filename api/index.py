"""
CAN Bus Security Simulator — Vercel Serverless API
POST /api/analyze  →  proxies to OpenAI
(Static frontend is served by Vercel directly from /frontend)
"""

import os
import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from mangum import Mangum

app = FastAPI(title="CAN Bus Security Simulator API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class AnalyzeRequest(BaseModel):
    attackMode: str = "none"
    busLoad: str = "0%"
    frameRate: str = "0"
    totalFrames: str = "0"
    attackFrames: str = "0"
    anomalies: str = "0"
    speed: str = "0"
    model: str = "gpt-4o"
    lang: str = "ko"


@app.post("/api/analyze")
async def analyze(req: AnalyzeRequest):
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="OPENAI_API_KEY not configured on server. Use client-side key.",
        )

    mode_names = {
        "none": "Normal (no attack)",
        "flood": "DoS Flooding Attack",
        "spoof": "Speed Spoofing Attack",
        "fuzz": "Data Fuzzing Attack",
        "malfunc": "Malfunction Injection Attack",
        "replay": "Replay Attack",
        "busoff": "Bus-Off Attack",
        "suspension": "Suspension ECU Attack",
        "masquerade": "Masquerade Attack",
    }
    mode_label = mode_names.get(req.attackMode, req.attackMode)
    lang_instr = (
        "반드시 한국어로 답변하세요." if req.lang == "ko" else "Reply in English."
    )

    prompt = (
        "You are a CAN bus cybersecurity expert analyzing a Hyundai Sonata vehicle "
        "network attack simulation.\n\n"
        f"Current state:\n"
        f"- Attack mode: {mode_label}\n"
        f"- Bus load: {req.busLoad}\n"
        f"- Frame rate: {req.frameRate} frames/sec\n"
        f"- Total frames: {req.totalFrames}\n"
        f"- Attack frames: {req.attackFrames}\n"
        f"- IDS anomalies detected: {req.anomalies}\n"
        f"- Vehicle speed (from 0x0316): {req.speed} km/h\n\n"
        "Provide a concise technical analysis (3-5 sentences) covering:\n"
        "1. What this attack does to the CAN bus\n"
        "2. Observed metrics and what they indicate\n"
        "3. Potential real-world vehicle safety impact\n"
        "4. One recommended IDS countermeasure\n\n"
        f"{lang_instr}"
    )

    payload = {
        "model": req.model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 400,
        "temperature": 0.7,
    }

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {api_key}",
                },
                json=payload,
            )
            resp.raise_for_status()
            return resp.json()
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="OpenAI API request timed out.")
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=e.response.text)


# Vercel serverless handler
handler = Mangum(app, lifespan="off")
