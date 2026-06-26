FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_SYSTEM_PYTHON=1 \
    PATH="/root/.local/bin:${PATH}"

WORKDIR /app

RUN pip install --no-cache-dir uv

COPY pyproject.toml uv.lock README.md sitecustomize.py ./
COPY garza_mcp ./garza_mcp

RUN uv sync --frozen --no-dev

EXPOSE 3104

CMD ["uv", "run", "python", "-m", "garza_mcp.server"]
