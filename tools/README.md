# Stream Probe Tools

This directory contains helper tools for checking how real provider streams are handled by `src/buffer`.

```txt
tools/common.ts
tools/openai-stream-probe.ts
tools/gemini-stream-probe.ts
```

`lemon-model` owns provider-neutral buffer, socket, and transport code only. These probes are therefore limited to direct SDK stream checks against `GenAIStreamBuffer`.

OpenAI/Gemini manager comparisons are not supported here. Run manager checks from the application that owns provider manager integration instead.

## Install Provider SDKs First

Provider SDKs are intentionally not pinned as `lemon-model` package dependencies.

Install the SDK you need in the workspace where you run the probe:

```bash
npm install -D openai
npm install -D @google/genai
```

You also need the matching API key.

## Run Direct Probes

OpenAI:

```bash
OPENAI_API_KEY=... npx ts-node tools/openai-stream-probe.ts --kind text --probeMode direct
```

Gemini:

```bash
GEMINI_API_KEY=... npx ts-node tools/gemini-stream-probe.ts --kind text --probeMode direct
```

Only `--probeMode direct` is supported in `lemon-model`.

These options require provider manager integration outside this package:

```txt
--managerCheck true
--probeMode manager
--probeMode both
```

## Samples

Probe output samples live in:

```txt
sample/openai
sample/gemini
sample/image
```

`sample/openai` and `sample/gemini` contain YAML/JSON stream captures. `sample/image` contains image artifacts referenced by those sample files.
