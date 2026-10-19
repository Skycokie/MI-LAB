# Build context = repository root (Railway dockerfilePath = backend/Dockerfile)
FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

COPY backend/requirements.txt .
RUN pip install --upgrade pip && pip install -r requirements.txt

COPY backend/requirements-kronos.txt .
# Kronos/torch is optional and heavy — skip quietly if install fails on free tiers.
RUN pip install -r requirements-kronos.txt || true

COPY backend/ .
RUN mkdir -p /app/data

EXPOSE 8000

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
