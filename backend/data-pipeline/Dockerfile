# syntax=docker/dockerfile:1.7
FROM python:3.12-slim

LABEL version="1.0" \
      maintainer="Tamhid Chowdhury <tamhidchowdhury@gmail.com>" \
      description="Web Application for English Premier League Data Analytics"
LABEL org.opencontainers.image.source https://github.com/tamhid92/epl-data

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get -y install libpq-dev gcc \
    ca-certificates tzdata curl \
    && pip install psycopg2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
RUN useradd -u 10001 -m appuser
USER appuser

ENTRYPOINT ["python", "/app/data_pipeline.py"]