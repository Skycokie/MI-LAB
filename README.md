# Market Institutional Lab (MI-LAB)

Institutional market analysis lab: GEX, COT, Volume Profile, Footprint, Scanner, Kronos Forecast, and **Watchlist Alerts** with Alpaca Paper risk.

## Repo

- GitHub: https://github.com/Skycokie/MI-LAB

## Local backend

```bash
cd backend
python -m venv venv
.\venv\Scripts\pip install -r requirements.txt
# optional Kronos:
.\venv\Scripts\pip install -r requirements-kronos.txt
copy .env.example .env   # fill Alpaca keys
.\venv\Scripts\uvicorn.exe main:app --reload --port 8000
```

## Local frontend

```bash
cd frontend
npm install
npm run dev
```

Set `NEXT_PUBLIC_API_URL` to the backend URL (default `http://localhost:8000`).

## Railway

Backend deploys from `backend/Dockerfile`. Required env vars:

- `ALPACA_API_KEY_ID`
- `ALPACA_API_SECRET_KEY`
- `CORS_ORIGINS` (comma-separated frontend origins)

Optional: `ALERT_POLL_SEC` (default `60`).

Alerts DB lives under `/app/data` (ephemeral on free Railway unless you attach a volume).
