# 03 — Models in use

pi gets its models from the built-in provider catalog (auto-generated
`models-store.json`) plus custom providers in `models.json`. On this machine there is
exactly one custom provider — local Splash with three models (`docs/04-splash.md`).
Cloud keys may exist in personal `auth.json`, but cloud models are excluded from the
picker by `enabledModels` — the environment is local-only by design.

## Live model table

| Provider (in pi) | Model | Context | Served by | Status |
|---|---|---|---|---|
| `splash` | `mlx-community/Qwen3.8-27B-4bit` | 74 K | local Splash, `127.0.0.1:8000` | **default model — the brain** |
| `splash` | `mlx-community/Qwen3.6-35B-A3B-4bit` | 64 K | local Splash | available (fast hybrid: 35 B total / ~3 B active) |
| `splash` | `prism-ml/Ternary-Bonsai-2-27B-gguf:PQ2_0` | 64 K | local Splash | available (ternary-quant, lightest RAM) |
| cloud (`anthropic`, `openai`, `huggingface` catalog) | — | — | cloud | keys in personal `auth.json`; **excluded from picker** via `enabledModels` |

## The `splash` provider (`pi/models.json`, vendored as-is)

```json
{
  "providers": {
    "splash": {
      "api": "openai-completions",
      "apiKey": "splash-local",
      "baseUrl": "http://127.0.0.1:8000/v1",
      "models": [ ...three models below... ]
    }
  }
}
```

- `api: openai-completions` — Splash exposes an OpenAI-compatible HTTP API; pi talks to
  it like any other OpenAI endpoint.
- `apiKey: "splash-local"` — a **sentinel string**; the local server ignores auth. It
  must be non-empty because pi requires an API key per provider. Not a secret.
- `baseUrl: http://127.0.0.1:8000/v1` — loopback only; the server never listens on LAN.

The three model entries (all `reasoning: true`, zero `cost` — local):

| Model | `contextWindow` | `maxTokens` | `thinkingLevelMap` | Notes |
|---|---|---|---|---|
| `mlx-community/Qwen3.8-27B-4bit` | 74000 | 56614 | full 5-level (`off→none`, `low/medium/high/xhigh` pass through) | dense 27 B @ 4-bit; the primary brain; the only model with a full thinking-level map |
| `mlx-community/Qwen3.6-35B-A3B-4bit` | 64000 | 56614 | collapsed: `off→null`, `low→low`, `high→xhigh`, `xhigh→xhigh` | hybrid MoE, ~3 B active — much faster; only two effective thinking strengths |
| `prism-ml/Ternary-Bonsai-2-27B-gguf:PQ2_0` | 64000 | 56614 | same collapsed map | ternary-quantized (PQ2_0) 27 B — smallest memory footprint of the three |

The context windows are deliberately *under* the models' raw limits: 74 K / 64 K leaves
room for int8 KV-cache inside 32 GB of unified memory (`docs/04-splash.md` has the math).
`maxTokens` (56614) is the output budget, paired with the per-model compaction
`reserveTokens` in `settings.json` (25600 / 20480 / 20480) so long generations can't
starve the context window.

## How the models are wired into pi

- `settings.json`: `defaultProvider: splash`, `defaultModel:
  splash/mlx-community/Qwen3.8-27B-4bit`, `defaultThinkingLevel: xhigh`,
  `enabledModels: [the three]` — the picker shows **only local models**; cloud models
  from the auto-generated catalog are hidden (a cloud key in `auth.json` is an escape
  hatch you opt into by editing `enabledModels`, not the default).
- `pi-compaction-model` extension (`docs/05-extensions.md`): allows compaction to run on
  a dedicated model; here compaction uses the active model with the `settings.json`
  overrides above.
- `models-store.json` is pi's **auto-generated** cache of the built-in provider catalog
  (~80 KB, contains the `anthropic`/`huggingface` registry entries). Never edit it by
  hand and never commit it — pi rewrites it.

## Cloud keys (personal — never committed)

`~/.pi/agent/auth.json` holds personal API keys (OpenAI, Anthropic). The config repo
gitignores it and the docs never reference its values. If you mirror this setup and
want cloud fallback, create your own `auth.json` and add models to `enabledModels`
deliberately — the default stance of this environment is **local-only**.
