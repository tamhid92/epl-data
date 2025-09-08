FROM python:3.14-rc-slim

LABEL version="1.0" \
      maintainer="Tamhid Chowdhury <tamhidchowdhury@gmail.com>" \
      description="Web Application for English Premier League Data Analytics"
LABEL org.opencontainers.image.source https://github.com/tamhid92/epl-data

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

COPY requirements.txt .

RUN apt-get update \
    && apt-get -y install libpq-dev gcc \
    ca-certificates tzdata curl \
    && pip install psycopg2 \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

CMD ["gunicorn", "-w", "4", "-k", "gthread", "--threads", "8", "--timeout", "30", \
     "--bind", "0.0.0.0:8000", "app:app"]