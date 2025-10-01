FROM python:3.12-slim

LABEL version="1.0" \
      maintainer="Tamhid Chowdhury <tamhidchowdhury@gmail.com>" \
      description="FPL prediction model and upload that predictions to postgres"
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
RUN chown -R 10001:10001 /app
USER 10001

ENTRYPOINT ["python", "/app/entrypoint.py"]
CMD ["update"]