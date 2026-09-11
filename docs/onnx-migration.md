# Slice 1.3 — ONNX embedding backend

**Status:** specified, not built. Architect-owned, like `api-contract.md` and
`testing.md`. The backend agent is read-only on `docs/`.

## Why

The deploy target sizing exposed the real cost. Measured on this project's real
997-article database:

| stage | RSS |
|---|---|
| baseline interpreter | 16 MB |
| after `import torch` | 121 MB |
| after model load + encode | 639 MB (peak 673) |
| after full cluster | 680 MB (peak **692**) |

692 MB does not fit Render's 512 MB plans, so the choice was a ~$25/mo 2 GB
instance or removing the reason for it. Almost all of that is **torch, a
training framework, loaded to run inference on a 90 MB model**. We never call a
gradient. `onnxruntime` runs the same weights without it.

This is a cost fix second and a correctness-of-dependencies fix first: it also
deletes ~800 MB from the install, which is the slowest step in CI and would be
the slowest step in every Docker build.

## What must not change

These are the constraints that make the migration verifiable. Breaking any of
them turns a mechanical swap into a re-tuning project.

- **`docs/api-contract.md` is untouched.** No route, shape, or status code moves.
- **Similarity threshold stays 0.62.** It was swept against live data; re-sweeping
  is a separate slice with its own evidence. The whole point of the design below
  is that 0.62 remains valid.
- **`agglomerative.group_by_cosine` is not modified.** Grouping is already shared
  between implementations. Only vector *production* changes.
- **The `Clusterer` protocol in `clustering/base.py` is not modified.**
- **TF-IDF keeps working**, including the `pipeline.recluster` mid-run fallback
  and the `get_clusterer` construction-time fallback.

## Decisions already made (do not re-litigate)

**Use `onnx/model.onnx` — fp32, 90.4 MB. Not the int8 variants.**
The HF repo also ships `model_qint8_*.onnx` at 23 MB. They are rejected on
purpose: int8 quantization perturbs the vectors, which would invalidate the
0.62 threshold and force a re-sweep — the expensive, risky work this slice
exists to avoid. fp32 ONNX reproduces torch's vectors to within float noise, so
the migration can be *proven* equivalent instead of argued. We are targeting
~200 MB, not ~50 MB; 90 MB of weights is affordable.

**Sequence length is 256, not the tokenizer's default 512.**
`SentenceTransformer.max_seq_length` for this model is 256 and its tokenizer's
`model_max_length` is 256. Truncating at the wrong length silently changes the
vector for any long input. Verified, not assumed.

**Pooling is attention-masked mean, then L2 normalize.**
The loaded model is exactly `Transformer → Pooling → Normalize`, with
`pooling_mode_mean_tokens: True` and every other pooling mode false. Mean must
be over *unmasked* tokens only — dividing by the padded length instead of the
mask sum is the single most likely way to get this subtly wrong, and it will
only show up on short texts in a padded batch. The equivalence check below is
designed to catch exactly that.

**Model artifacts come from the HF hub via `huggingface_hub`**, so local dev and
the Docker build share one cache mechanism (`HF_HOME`), and the image can
pre-warm it at build time rather than downloading on first request.

**`embedding.py` stays in the tree.** It becomes the reference implementation
that documents what ONNX must match, and the means to re-verify equivalence
after any future model change. It moves out of the default install: torch and
sentence-transformers move to a new `requirements-torch.txt`. `get_clusterer`
already falls back when a clusterer cannot be constructed, so an environment
without torch behaves correctly with no code change.

## Deliverables

1. `app/clustering/onnx_embedding.py` — `OnnxClusterer` implementing the
   `Clusterer` protocol. `vectors()` does tokenize → ONNX session → masked mean
   pool → L2 normalize, returning `float32` rows aligned with `documents`.
   `cluster()` delegates to `group_by_cosine`, exactly as `embedding.py` does.
2. `clustering/__init__.py` — register `"onnx"` in `_build`. **`onnx` becomes the
   default** in `config.py` (`NEWSPRISM_CLUSTERER`).
3. `requirements.txt` — drop `torch` and `sentence-transformers` and the
   `--extra-index-url` line that exists only for torch; add `onnxruntime`,
   `tokenizers`, `huggingface_hub`, all pinned. Keep `numpy` and `scikit-learn`.
4. `requirements-torch.txt` — the reference path: `-r requirements.txt` plus the
   torch extra index, `torch==2.8.0+cpu`, `sentence-transformers==5.1.1`.
5. Tests, in the existing pytest suite, that run **without network and without
   torch**. Test the parts that are yours to get wrong, not the model:
   - masked mean pooling against hand-computed values, including a batch where
     padding would change the answer if the mask were ignored;
   - rows are unit-norm;
   - output row order matches input document order;
   - empty input returns shape `(0, 384)`;
   - `.env.example` and `backend/README.md` updated for the new default and vars.

Do **not** write the torch-vs-ONNX equivalence check. The Architect owns that
and runs it against the real database; see below.

## Acceptance criteria

The Architect will verify these against the project's real 997-article DB using
a baseline already captured from the current torch implementation
(856 in-window docs → 657 groups, 104 multi-source; 997 full-corpus docs → 768
groups, 119 multi-source).

| # | criterion | threshold |
|---|---|---|
| 1 | per-row cosine between ONNX and torch vectors | **min ≥ 0.9999** |
| 2 | max absolute per-element difference | ≤ 1e-3 |
| 3 | group partition on the in-window corpus | **byte-identical** to baseline |
| 4 | peak RSS during one windowed pass | **< 400 MB**, ≥ 20% headroom on 512 MB |
| 5 | existing backend suite | still green, both `pytest` and `python -m pytest` |

Criterion 3 is the product-level one: same stories, same spread, same page.
Criteria 1–2 are what make 3 reproducible rather than lucky.

### Criterion 4 was revised after the fact, and the original was the Architect's error

It first read **< 250 MB**, which is not reachable and never was: importing the
app at all — numpy, scikit-learn, fastapi, feedparser, before a single model
weight is read — already costs ~139 MB. The target was set by subtracting a
guess from 512 rather than by measuring the floor, which is the same class of
mistake as a fixture that simplifies the thing it stands in for.

The agent measured 377 MB, reported it as a failure against the stated number,
and explicitly declined to reach the target by quantizing or by moving the
threshold. That was the correct response to a wrong spec, and it is why "how to
fail" is written down before dispatch. The number moved; the discipline held.

Measured on the real 855-document window, whole app imported, one pass per
process — the batching lever the agent flagged as untried is what closed the gap:

| `batch_size` | ingest peak | idle steady state | headroom on 512 MB |
|---|---|---|---|
| 32 | 405.7 MB | 302.0 MB | 21% |
| 16 | 357.7 MB | 300.3 MB | 30% |
| **8** | **332.3 MB** | 301.5 MB | **35%** |

Wall-clock was indistinguishable across all three, so the headroom is bought for
no measurable time. **Steady state is ~300 MB regardless of batch size** — that
is the resident ONNX session plus the app, and it is the number that decides the
plan; the peak is transient encode overhead on top of it.

### The number that ships is 355 MB, not 332 MB

The table above was measured through `clusterer.cluster()`. QA then found that
`pipeline.recluster()` calls `clusterer.vectors()` **and** `clusterer.cluster()`,
and `cluster()` re-encodes internally — so production encodes the window twice.
Re-measured through the real `recluster()` path against a copy of the real
database, whole app imported:

| | |
|---|---|
| after app import | 139.8 MB |
| after `recluster()` | 308.5 MB resident, **355.4 MB peak** |
| headroom on a 512 MB plan | **156.6 MB (31%)** |
| wall clock | 63.9 s for 855 articles |

Still inside the revised criterion, and still a 336 MB reduction from torch's
692 MB. Recorded because measuring a convenient shortcut of the production path
rather than the path itself is the same error as a fixture that simplifies what
it stands in for — the shortcut understated the real figure by 23 MB.

**The double encode is a real defect and is deliberately not fixed here.** It
predates this slice (`embedding.py` had the same shape), and fixing it properly
means changing the `Clusterer` protocol — which this spec forbids — so that the
pipeline can get vectors and groups from one pass. It roughly doubles ingest CPU
time; ~25 s of the 63.9 s above is redundant work. See "Known issues" in
CLAUDE.md; it wants its own slice and its own decision about the seam.

## How to fail

Pre-authorized, because an agent that improvises under a blocked constraint is
worse than one that stops:

- **If fp32 ONNX cannot hit criterion 1**, stop and report the actual numbers.
  Do **not** compensate by moving the 0.62 threshold, and do **not** switch to a
  quantized model to make a number look better.
- **If `tokenizers` output disagrees with the HF tokenizer**, stop and report.
  Do not hand-roll WordPiece.
- **If a pin will not resolve on Python 3.13**, report the resolver error and the
  version you would use instead; do not silently unpin.
- Report anything you had to decide that this document did not specify. The
  contract's one historical failure was an omission, not a contradiction.

## Baseline location

Captured by the Architect from the real DB (not a fixture):

```
<scratchpad>/baseline/
  meta.json           model, threshold, window days
  window_ids.json     the 856 in-window article ids, in order
  window_docs.json    id/title/summary for each
  window_vecs.npy     torch vectors, (856, 384) float32
  window_groups.json  canonical (sorted) group partition
  full_*.{json,npy}   same for all 997 articles
```

Read it if useful; it is regenerable and must not be committed.
