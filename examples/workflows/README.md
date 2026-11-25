# Workflow recipes

A workflow is a JSON recipe the engine runs step by step. Relative paths resolve from the workflow file's folder.

```sh
reelforge workflow validate reel-from-folder.json
reelforge workflow run reel-from-folder.json              # stops at AI Director steps for review
reelforge workflow run reel-from-folder.json --approve-ai # also applies AI Director proposals
reelforge workflow run reel-from-folder.json --resume <run> # after you applied the proposal: the remaining steps
reelforge workflow runs
```

| Step | Does |
|---|---|
| `import {paths}` | Imports files; `*` globs and `~` work |
| `analyze {assets?, kinds?, language?}` | Scenes / beats / transcript (all applicable by default) |
| `append {asset, track, duration?, sourceIn?, props?}` | Adds a clip at the end of a track (`V1`, `A1`…) |
| `edit {operations}` | Any timeline operations; `${asset:name}`, `${track:V1}`, `${clip:name#n}` and times like `"2s"` (also for `fadeIn`, `fadeOut`, `transitionIn`) are resolved |
| `captions {source?, maxWords?, language?, style?}` | Transcribes if needed, then captions (`style`: `bold`, `clean`, `boxed` or a style object) |
| `director {instruction, provider?, model?}` | Asks the AI Director. Unless `--approve-ai`, the run stops here (`waiting_approval`): apply the proposal (AI Director panel or `reelforge ai apply <id> --yes`), then `workflow run <file> --resume <run>` runs the remaining steps |
| `preview {}` · `render {out}` | Preview render · MP4 export (never overwrites) |

Steps you write out are approved by running the workflow yourself (CLI or Automate). AI Director steps are not: the AI
can only propose. A workflow an AI client sends over MCP is not approved by being run: the client must ask you first.
