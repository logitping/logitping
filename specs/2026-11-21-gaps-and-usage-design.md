# Likelihood gaps instead of IID confidence, and reported token usage: design

Status: drafted on 2026-11-21 as the two small changes of the 0.8.0 plan; the user chose both options below on 2026-11-21.

## Context

**IID confidence.** For an `IDENTIFIED` result, `ProbeResult.confidence` is the winner's softmax weight under an IID multinomial model. Every `ModelScore.weight` is the same quantity for each model, and the CLI prints both as percentages: `Nominal model-relative confidence: 99.99%` and `gpt-6.1-sol: 99.99%`. The 2026-11-21 review measured how far real runs depart from that model: the variance of the log-likelihood ratio ranges from 0.13× to 26× the IID prediction. `docs/bank.md` records wrong matches with "confidence" above 99.99%. These numbers read as identity probabilities and are not.

**Token usage.** Providers report token counts. The input count of the fixed prompt depends on the tokenizer and the chat template, so it is a candidate fingerprint signal. Nothing reads these counts today. They also arrive late:
- Anthropic Messages reports input tokens in `message_start`, its first event.
- OpenAI Responses reports usage in `response.completed`, its last event.
- Chat Completions reports it in the final chunk, and only when the endpoint sends it unasked; OpenAI itself requires `stream_options`.

The engine aborts the stream as soon as it has the requested integers (`src/core/engine.ts`), so for OpenAI formats the usage event is never read.

## Decisions

| Topic | Decision |
| --- | --- |
| Confidence | Remove `ProbeResult.confidence` and `ProbeResult.confidenceMeaning`. The CLI no longer prints `Nominal model-relative confidence`. This is breaking, as the 0.8.0 plan accepted. |
| Gaps | Replace `ModelScore.weight` with `logLikelihoodGap: number \| null`: how many nats the model's log likelihood falls behind the most likely model's, 0 for the most likely itself. It is set when `weight` used to be set: a sequential test exists and at least one envelope accepts. Otherwise it is `null`, as for pooled banks, single-model banks and all-reject results. The naming rule compares the runner-up's gap with the threshold. |
| CLI scores | Sorted by gap, unranked last. Each line shows the gap instead of the percentage, as `0.0 nats` or `−2.0 nats` with one decimal; `unranked` when `null`. |
| Warning text | "Nominal confidence assumes fixed IID categorical distributions. LLM integers are dependent; validate error rates empirically." becomes "The naming threshold assumes independent integers from fixed distributions; LLM integers are dependent, so validate error rates empirically." |
| Not changed | `SequentialDecision.weights` (math-level, documented as not identity accuracy), the naming rule, candidates, pooled scoring. |
| Usage type | `TokenUsage { inputTokens: number \| null; outputTokens: number \| null }`. Only nonnegative safe integers are kept, and anything else stays `null`. |
| Transport contract | Additive. `ProbeRequest.onUsage?: (usage: TokenUsage) => void` is called whenever the provider reports counts. `ProbeTransport.reportsUsage?: boolean` declares that a transport calls it. `HttpClient` sets `reportsUsage: true`; drivers and custom transports are unchanged. |
| Parsing | Chat Completions: any chunk with `usage.prompt_tokens` / `usage.completion_tokens`. Responses: `response.completed` or `response.incomplete` with `response.usage.input_tokens` / `output_tokens`. Messages: `message_start` `message.usage.input_tokens` (and `output_tokens`), then `message_delta` `usage.output_tokens`. A later report overwrites the field it sets. `complete()` is unchanged. |
| Reading to the end | For a transport with `reportsUsage`, after the last needed integer the engine keeps reading, without parsing, until the stream ends or 5,000 ms pass (`USAGE_GRACE_MS`), then stops. An early stop at a checkpoint still aborts at once. An error or abort during this tail is ignored, because the integers are complete; a user's cancellation still cancels the probe. Transports without `reportsUsage` stop at the count, as today. |
| Result | `ProbeResult.usage?: TokenUsage[]`: one entry per integer request sent, in order, so 1 entry for a single request and up to 8 for a pooled probe, including a short or repeated final reply. The tokenizer request is excluded. Present only when the transport has `reportsUsage`. |
| CLI | After the integer count line it prints `Reported tokens (input/output): 52/1630`. A pooled probe prints one pair per request, comma-separated, and an unknown count prints as `?`. |
| Identification | Usage is recorded only. Scoring, banks and the evaluation report do not use it. |

## Documentation changes

Fixed copy.

**`README.md`:**
- In the "Experimental 0.7.0" paragraph, replace "`confidence` is a relative likelihood under statistical assumptions, not an empirically validated identity probability." with: "Results report likelihood gaps between enrolled models, not identity probabilities."
- In the Quickstart excerpt, delete the line `  "confidence": null,`.
- In the `HEURISTIC_MATCH` row of "Understand the result", delete "; `confidence` is `null`".
- In the library example, replace `console.log(result.status, result.model, result.confidence);` with `console.log(result.status, result.model, result.candidates);`.

**`docs/library.md`:** in its example, make the same `console.log` replacement.

**`docs/cli.md`:**
- Replace "A reference match in this mode returns `HEURISTIC_MATCH`, the candidate in `model`, and `confidence: null`. Reference weights and distances appear in `scores`;" with: "A reference match in this mode returns `HEURISTIC_MATCH` and the candidate in `model`. Likelihood gaps and distances appear in `scores`;"
- Replace "An uncalibrated bank returns `UNCALIBRATED`, with no confidence or candidate ranking." with: "An uncalibrated bank returns `UNCALIBRATED`, with no candidates or likelihood gaps."
- Append to the paragraph that begins "`--max-tokens <n>` sets the output-token budget":

  > The result's `usage` lists the token counts the provider reported for each integer request; the readable output prints them as `Reported tokens (input/output)`. To capture counts that arrive in a stream's last event, the probe keeps reading for up to 5 s after the last needed integer, which can add a few billed output tokens.

**`docs/methodology.md`:** replace "Relative weights use log-sum-exp with equal priors. They are computed only after at least one OOD region accepts the observation and **are not calibrated identity probabilities**." with:

> Each score reports its `logLikelihoodGap`: how many nats its log likelihood falls behind the most likely model's. The naming rule compares the runner-up's gap with the threshold. Gaps are computed only after at least one OOD region accepts the observation. Results report no identity probability: under the dependence measured in real runs, a gap does not convert into one.

**`SECURITY.md`:** replace "Behavioral similarity and nominal confidence do not prove identity" with "Behavioral similarity and likelihood gaps do not prove identity".

**`CHANGELOG.md`, under `## Unreleased`:**

- Add under `### Changed`, first:

  > - **Breaking:** results no longer report `confidence` or `confidenceMeaning`, and each score's `weight` is replaced by `logLikelihoodGap`: how many nats behind the most likely model it is. These were softmax weights under an independence assumption that real runs violate, so they read as identity probabilities they were not. The readable output prints gaps instead of percentages.

- Add under `### Added`:

  > - Results report `usage`: the input and output token counts the provider reported for each integer request, recorded for future tokenizer comparison and not used for identification. To capture counts that arrive at the end of a stream, an API probe keeps reading for up to 5 s after the last needed integer. Transports opt in with `reportsUsage` and `ProbeRequest.onUsage`.

## Out of scope

- Enrolling or scoring token counts.
- Adding `stream_options` to Chat Completions requests (the user chose not to).
- Recording usage during bank collection.
- Usage from CLI drivers.
- Removing `SequentialDecision.weights`.
- Rewriting the historical weight figures in `docs/bank.md`.
