# newsprism backend — the image Render runs.
#
# Build context is backend/ (render.yaml sets dockerContext). Nothing here is
# Render-specific except the $PORT convention: deployment details like the
# database path and CORS origins are passed as environment variables by
# render.yaml, so this image also runs locally with `docker run`.

FROM python:3.13-slim

# PYTHONUNBUFFERED so logs reach Render's log stream as they happen rather than
# when a buffer fills — a 60s ingest that appears to hang is not debuggable.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HOME=/opt/hf

WORKDIR /app

# Dependencies before source, so editing a route does not reinstall onnxruntime.
# requirements.txt only — never requirements-torch.txt. The torch extra exists
# solely to re-verify ONNX/torch vector equivalence (docs/onnx-migration.md);
# installing it here would add ~800 MB to the image to run code that is never
# imported in production.
COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY app ./app

# Bake the model into the image rather than downloading on first ingest.
#
# Two reasons beyond speed. The first ingest would otherwise pay a ~90 MB
# download on a 0.5 CPU instance, and — worse — a download failure at that
# moment degrades to the TF-IDF fallback, which produces a fraction of the
# multi-source clusters. That failure is invisible in the UI: the page still
# renders, just with far less coverage spread, which is the one thing this
# product exists to show.
#
# This runs the REAL clusterer rather than fetching file paths, so the build
# fails if the model cannot actually load and encode. The name assertion is
# load-bearing: get_clusterer() deliberately falls back to TF-IDF when a
# clusterer will not construct, so without it a missing onnxruntime would
# produce a green build and a quietly degraded image.
ENV NEWSPRISM_CLUSTERER=onnx
RUN python -c "\
from app.clustering import Document, get_clusterer; \
c = get_clusterer(); \
assert type(c).__name__ == 'OnnxClusterer', 'silently fell back to ' + type(c).__name__; \
v = c.vectors([Document(id='warm', title='warming the model cache', summary='')]); \
assert v.shape == (1, 384), v.shape; \
print('model cache warmed:', c.name)"

# The image now carries every artifact it needs, so forbid runtime hub access:
# no revision check on startup, no network dependency mid-ingest, and no
# chance of silently pulling a different revision than the one tested here.
ENV HF_HUB_OFFLINE=1

# Render provides $PORT and expects the service to bind 0.0.0.0. Shell form so
# it expands; the default keeps `docker run -p 8000:8000` working locally.
# No --workers: one process per instance is deliberate, since a second worker
# would load a second copy of the model and double resident memory on a 512 MB
# plan. Ingest is I/O- and CPU-bound batch work, not a concurrency problem.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
