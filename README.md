# FORGE

A trustworthy multi-agent AI software engineering platform with real-time 3D visualization.

Spawn parallel AI agents, watch them work in a live 3D office, approve plans before any code runs, and get verified, git-committed results — not just suggestions.

---

## What it does

- **CodePlan** analyzes your workspace and produces an execution plan — you approve it before anything runs
- **Parsel** decomposes the plan into parallelizable tasks
- **SWE-Agent** (up to 5 parallel workers) writes, edits, and verifies code — diffs visible in real time
- **AutoCodeRover** reviews the final output for correctness
- Every action is live-streamed to a 3D scene where you can watch your agent team work

## Trust Pillars

| Pillar | What it means |
|--------|--------------|
| Transparency | Every file change shows a unified diff |
| Reversibility | Single atomic git commit per task, fully revertable |
| Verification | Syntax checks + tests run before marking task done |
| Plan Gate | User must approve the execution plan before agents touch code |

---

## Stack

- **Backend**: Python, FastAPI, LangGraph, Google Gemma (via Gemini API)
- **Frontend**: React 19, Three.js (WebGPU), Monaco Editor, Zustand, Tailwind CSS
- **Agents**: LangGraph 1.2 with MemorySaver, interrupt-based HITL

---

## Setup

### Prerequisites

- Python 3.11+
- Node.js 20+
- Docker (for sandboxed code execution)
- Google AI API key — [get one here](https://aistudio.google.com/app/apikey)

### Backend

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate      # Windows
pip install -r requirements.txt
cp .env.example .env        # add your API key
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev
# opens at http://localhost:3000
```

### First run

1. Click the key icon in the top-right → paste your Gemini API key + select workspace folder
2. Click **New Task** → describe what you want built
3. Review the execution plan → Approve
4. Watch agents work in the 3D scene

---

## Security

- Agent code execution is sandboxed inside Docker (`/workspace` only)
- `MAX_STEPS = 50` hard recursion limit on all LangGraph loops
- High-risk actions (file deletes, git resets) require HITL approval
- Rate limiter caps API calls at 13/min (below the 15/min limit)

---

## License

MIT
