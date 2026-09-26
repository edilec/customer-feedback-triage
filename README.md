# Customer Feedback Triage

`TOOL_ID=customer-feedback-triage`. Zero-dependency Node 22+ reporter for local, exported, redacted feedback. It reads one JSON document and writes a deterministic version 1 JSON report to stdout. Its library exports `TOOL_ID`, `LIMITS`, and `triageFeedback(document, clock?)`.

```sh
node bin/customer-feedback-triage.mjs --root examples --input passing.json
node bin/customer-feedback-triage.mjs --root examples --input failing.json
npm run check
```

The examples exit `0` and `1`. `--help` prints usage; `--human` adds a short stderr summary. The input must be a real file confined to the real `--root`; an escaping symlink is refused. No network access, model call, source mutation, or output file is used.

## Input and decisions

The document requires `schemaVersion: "1"`, nonempty `taxonomy` and nonempty `feedback` arrays. A taxonomy entry has a lower-case slug `tag` and one or more unique lower-case ASCII keywords; repeating a keyword within one tag is invalid rather than extra evidence. A feedback record has an original opaque `id` (`fb-` followed by 1–12 digits, or a UUID), `redacted: true`, nonempty `redactedText`, and optional `semanticSuggestions` entries `{tag, confidence}` with numeric confidence from 0 through 1. Suggestions must name a taxonomy tag. Source order supplies zero-based finding provenance; output items and group IDs sort by code-unit order.

Rule matching is case-insensitive with ASCII word boundaries. Each candidate exposes its tag and `ruleHits`; imported semantic suggestions retain their stated number as `semanticConfidence`. A rule match has `semanticConfidence: null`; no confidence is invented. One candidate is `suggested`, multiple are `ambiguous`, and none are `unmatched`. Every item has `reviewRequired: true`, even when the report passes. Groups are candidate-ID lists, not verified customer-intent labels. Keyword overlap across tags is a policy failure but leaves candidates reviewable.

The report never copies source text, raw suggestions, unknown fields, paths, or malformed JSON snippets. It emits only constrained opaque IDs, taxonomy slugs, numeric counts/confidences, fixed messages, and source ordinals. A common-pattern screen rejects emails, URLs, telephone-like numbers, and credential assignments; it is not a comprehensive privacy classifier. Producers must redact before export. If a record is not marked redacted, or a required field is ambiguous, the report is incomplete rather than green.

## Rules and exits

Findings use `@input` and zero-based JSON Pointers into the supplied file. They sort by `(file, pointer, ruleId)` in code-unit order. Messages do not echo input values.

| Rule | Severity | Result |
| --- | --- | --- |
| `input-unreadable`, `input-invalid`, `byte-limit`, `depth-limit`, `time-limit`, `record-limit` | warning | incomplete |
| `taxonomy-invalid`, `taxonomy-tag-duplicate`, `feedback-invalid`, `feedback-unredacted`, `feedback-id-duplicate`, `semantic-invalid`, `semantic-unknown-tag` | warning | incomplete |
| `keyword-conflict`, `private-text-detected` | error | fail |

Exit `0` is pass, `1` is an evaluated policy failure, and `2` is incomplete evidence or invalid usage. Invalid usage leaves stdout empty; malformed, non-UTF-8, unreadable, unsupported, or over-limit input yields an incomplete JSON report. Incomplete evidence takes precedence over failures in overall status.

Limits: 1,048,576 input bytes; 1,000 feedback records; 100 taxonomy entries; 20 keywords per tag; 10 semantic suggestions per feedback item; 4,096 characters of source text per item; JSON depth 16; 5,000 ms evaluation time. Exactly a bound is accepted, N+1 is incomplete. This tool does not infer impact, prioritize actions, verify customer intent, evaluate semantic-model quality, or guarantee de-identification.
