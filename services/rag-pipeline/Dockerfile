FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1
WORKDIR /app

FROM base AS deps
COPY requirements.txt requirements-dev.txt ./
RUN pip install -r requirements.txt -r requirements-dev.txt

FROM base AS runtime
ENV AXIOM_ENV=production
COPY requirements.txt ./
RUN pip install -r requirements.txt
COPY app ./app
USER nobody
EXPOSE 8000
LABEL org.opencontainers.image.source=https://github.com/axiom-ai/axiom
LABEL org.opencontainers.image.licenses=Apache-2.0
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
