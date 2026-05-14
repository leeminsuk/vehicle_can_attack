# CAN Bus Security Simulator

Interactive browser-based simulator for Hyundai Sonata CAN bus attack scenarios. Opens as a local `file://` HTML page — no build step, no server, no dependencies to install.

## What it does

The simulator replays real CAN bus data from the **OTIDS (Open CAN IDS Dataset)** and lets you inject three attack types in real time:

| Mode | Data source | What happens |
|------|-------------|--------------|
| Normal | OTIDS R-labeled frames | Real Sonata traffic at 500 Kbps |
| Flooding | OTIDS T-labeled frames | ID=0x0000 flood frames; bus load spikes >70% |
| Spoofing | Simulated | Fake 0x0316 speed frames injected at 200+ km/h |
| Fuzzing | Simulated | 2–4 random bytes corrupted per normal frame |

## Features

### Original panels
- **CAN Frame Stream** — scrolling table with all 8 bytes, label, decoded value, per-byte highlighting for changed/injected/fuzzed bytes
- **Vehicle State** — real-time decoded values (speed, steering, throttle, EPS torque, SAS, TCM, CGW)
- **ECU Node Status** — 12 ECUs with live active/compromised state
- **Bus Load Timeline** — Chart.js line chart, attack overlay color changes per mode
- **CAN Data Diff** — before/after bytes per ECU with delta badge
- **IDS / Anomaly Log** — timestamped detection events with flood/spoof/fuzz tags
- **Capture & Export** — record frames to OTIDS-format `.txt` during simulation

### Visual Simulator (new)
- **Speedometer SVG gauge** — colored zone arcs (green/yellow/red), animated needle, 0–260 km/h
- **RPM SVG gauge** — 0–8000 rpm, same zone coloring
- **Mini stats row** — Gear, Throttle, Steering
- **Top-down car canvas** — animated road with dashes, speed-lines at high speed; attack overlays:
  - Flood: red noise pixels, moving scanline, pulsing border
  - Spoof: ghost car ahead, dashed arrow, speed mismatch bar panel
  - Fuzz: glitch strips, random pixel blocks, orange tint
- **Warning lights bar** — NORMAL / ABS / ENGINE / STEER / SPEED / BUS ERR / IDS, pulse animation during active attacks

### AI Analysis (new)
- Enter an OpenAI API key (stored only in browser `localStorage`, never sent to any server other than `api.openai.com`)
- Select model (gpt-4o / gpt-4o-mini / gpt-3.5-turbo) and language (Korean / English)
- Click **Analyze Current Attack with AI** to get a 3–5 sentence technical analysis of the current attack state, metrics, safety impact, and a countermeasure recommendation
- Typing indicator, error bubbles, clear history button

## Usage

```
open /Users/chchou/vehicle_can_attack/index.html
```

or drag the file into any modern browser (Chrome, Firefox, Safari, Edge).

1. Click **Start** to begin replaying CAN data
2. Select an attack mode button (Flooding / Spoofing / Fuzzing)
3. Watch gauges, canvas, warning lights, and IDS log respond
4. Enter an OpenAI key and click Analyze for AI commentary
5. Use **Capture** → **Stop & Save** to export frames as OTIDS-format `.txt`

## Dataset

OTIDS dataset — Hyundai Sonata 2017, 500 Kbps CAN bus. Normal frames labeled `R`, flooding attack frames labeled `T`. Spoofing and fuzzing are simulated on top of normal frames.

**For educational and research use only.**
