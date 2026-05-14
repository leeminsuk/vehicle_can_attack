# CAN Bus Security Simulator

Interactive browser-based simulator for Hyundai Sonata CAN bus attack scenarios.  
Supports two deployment modes: **frontend-only** (open HTML directly in browser) or **backend + frontend** (FastAPI server with server-side OpenAI key).

## Project Structure

```
vehicle_can_attack/
├── index.html              # Original monolithic file (preserved)
├── backend/
│   ├── main.py             # FastAPI server — POST /api/analyze
│   ├── requirements.txt
│   └── .env.example
├── frontend/
│   ├── index.html          # Clean HTML — no inline JS/CSS
│   ├── css/
│   │   └── styles.css      # All extracted CSS
│   └── js/
│       ├── can-data.js     # SONATA_DATA, ECU_MAP, decodeFrame, VEH_ITEMS
│       ├── simulator.js    # Core simulation logic
│       ├── visualizer.js   # Gauges + canvas visual simulator
│       └── ai.js           # AI analysis panel
└── README.md
```

## What it does

The simulator replays real CAN bus data from the **OTIDS (Open CAN IDS Dataset)** and lets you inject three attack types in real time:

| Mode | Data source | What happens |
|------|-------------|--------------|
| Normal | OTIDS R-labeled frames | Real Sonata traffic at 500 Kbps |
| Flooding | OTIDS T-labeled frames | ID=0x0000 flood frames; bus load spikes >70% |
| Spoofing | Simulated | Fake 0x0316 speed frames injected at 200+ km/h |
| Fuzzing | Simulated | 2–4 random bytes corrupted per normal frame |

## Features

### Dashboard panels
- **CAN Frame Stream** — scrolling table with all 8 bytes, label, decoded value, per-byte highlighting for changed/injected/fuzzed bytes
- **Vehicle State** — real-time decoded values (speed, steering, throttle, EPS torque, SAS, TCM, CGW)
- **ECU Node Status** — 12 ECUs with live active/compromised state
- **Bus Load Timeline** — Chart.js line chart, attack overlay color changes per mode
- **CAN Data Diff** — before/after bytes per ECU with delta badge
- **IDS / Anomaly Log** — timestamped detection events with flood/spoof/fuzz tags
- **Capture & Export** — record frames to OTIDS-format `.txt` during simulation

### Visual Simulator
- **Speedometer SVG gauge** — colored zone arcs (green/yellow/red), animated needle, 0–260 km/h
- **RPM SVG gauge** — 0–8000 rpm, same zone coloring
- **Mini stats row** — Gear, Throttle, Steering
- **Top-down car canvas** — animated road with dashes, speed-lines at high speed; attack overlays:
  - Flood: red noise pixels, moving scanline, pulsing border
  - Spoof: ghost car ahead, dashed arrow, speed mismatch bar panel
  - Fuzz: glitch strips, random pixel blocks, orange tint
- **Warning lights bar** — NORMAL / ABS / ENGINE / STEER / SPEED / BUS ERR / IDS, pulse animation during active attacks

### AI Analysis
- Enter an OpenAI API key (stored only in browser `localStorage`)
- Select model (gpt-4o / gpt-4o-mini / gpt-3.5-turbo) and language (Korean / English)
- Click **Analyze Current Attack with AI** — calls backend `/api/analyze` if served via HTTP, falls back to direct OpenAI call if the backend is unavailable or has no key configured
- Typing indicator, error bubbles, clear history button

---

## Option A: Frontend-only (no server)

Open `frontend/index.html` directly in any modern browser:

```bash
open /Users/chchou/vehicle_can_attack/frontend/index.html
```

- All simulation runs in the browser
- Enter your OpenAI API key in the AI panel — it is stored in `localStorage` only and sent directly to `api.openai.com` (never to any server)
- No build step, no install required

---

## Option B: Backend + Frontend (FastAPI server)

The backend serves the frontend as static files and proxies AI requests using a server-side API key.

### Setup

```bash
cd backend

# Install dependencies
pip install -r requirements.txt

# Configure environment
cp .env.example .env
# Edit .env and set your OpenAI key:
#   OPENAI_API_KEY=sk-...

# Run the server
python main.py
```

Then open `http://localhost:8000` in your browser.

- The backend mounts `../frontend/` as static files at `/`
- `POST /api/analyze` reads the server-side `OPENAI_API_KEY`; returns 503 if not configured
- If the backend returns 503 (no server key), the UI automatically falls back to a client-side key if one is entered

---

## Dataset

OTIDS dataset — Hyundai Sonata 2017, 500 Kbps CAN bus.  
Normal frames labeled `R`, flooding attack frames labeled `T`.  
Spoofing and fuzzing are simulated on top of normal frames.

**For educational and research use only.**
