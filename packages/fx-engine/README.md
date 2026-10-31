# AI effects engine

`scripts/fx.py` with its models and fonts is **claude-video-effects** by Vibha Ramprakash
(<https://github.com/Vibha-Ramprakash/claude-video-effects>, commit `c97d01b`), MIT licence (`LICENSE`).
45 face-tracked motion-graphics effects for talking-head video.

- Face tracking: OpenCV YuNet (`models/yunet.onnx`, MIT). Person cut-out: MediaPipe Selfie Segmenter
  (`models/selfie_segmenter.tflite`, Apache-2.0). See `models/NOTICE.md`.
- Fonts: SIL OFL 1.1 (Archivo Black, Instrument Serif, Space Mono, Inter, Anton, Montserrat, Playfair Display)
  and Apache-2.0 (Permanent Marker); licences in `fonts/`.

## How ReelForge uses it

Clips carry AI effects as `props.aiEffects` (core `AiFxSchema`, catalogue in core `fx-catalog.ts`). The
render plan turns them into bakes (core `fx-bake.ts`); `@reelforge/media` cuts the stretch they cover from
the source into a clean intermediate at the project rate and runs `scripts/fx.py --plan` on it, never on the
user's file, and caches the result by key. Exports and the live preview both play the baked stretch.

Picture options (`images`) only take project assets; the engine gets a folder of links to them.

## Setup

- Development: `scripts/setup-fx.sh` (Python 3.11/3.12 venv in `.venv/`, pinned `requirements.txt`).
- Release: the desktop build bundles a Python runtime with these packages (`scripts/release/build-engine.mjs`).

## Updating

Copy the new `scripts/fx.py`, `models/` and `fonts/` from upstream, keep this README's commit current, bump
`FX_ENGINE_VERSION` in `packages/core/src/fx-bake.ts` (cached bakes are redone) and run the tests: one checks
that the catalogue in core still matches the effects `fx.py` defines.
