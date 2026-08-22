#!/usr/bin/env node
/**
 * Validate and render a design reviewer's structured advisory result.
 *
 * The trusted-publisher half of the review workflow: the model emits only
 * schema-validated JSON, and this enforces head freshness and body rules
 * before anything is posted. Consumers had two functionally equivalent copies
 * of it in two languages; this is the merge, with the wording each repository
 * needs supplied as arguments rather than baked in.
 *
 * One deliberate deviation from the older of the two: no duplicate-JSON-key
 * rejection. JSON.parse is last-value-wins and every surviving value is
 * validated below, so a smuggled duplicate cannot bypass the rules.
 */
import { writeFileSync } from "node:fs";
import { exit } from "node:process";

const FULL_SHA = /^[0-9a-f]{40}$/;
const EXPECTED_FIELDS = ["conclusion", "details", "reviewed_head_sha"];
const CONCLUSIONS = new Set(["FINDINGS", "INCOMPLETE", "PASS"]);
// Wording differs per consumer ("design drift" vs "spec drift"), so it is
// passed in. Everything below this line is the shared contract.
const PASS_SENTENCE = process.env.REVIEW_PASS_SENTENCE || "PASS — no material drift.";
const INCOMPLETE_SENTENCE =
  process.env.REVIEW_INCOMPLETE_SENTENCE || "INCOMPLETE — the review could not be completed.";
const HEADING_PREFIX = process.env.REVIEW_HEADING || "## Design Review";
const MAX_RESULT_BYTES = 64_000;
const MAX_DETAILS_BYTES = 60_000;
const MAX_COMMENT_BYTES = 65_000;

function fail(message) {
  console.error(`could not render review: ${message}`);
  exit(1);
}

function requireSha(value, label) {
  if (typeof value !== "string" || !FULL_SHA.test(value)) {
    fail(`${label} must be a lowercase 40-character SHA`);
  }
  return value;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if ((key !== "--expected-head" && key !== "--output") || value === undefined) {
      fail(`unknown or valueless argument ${key}`);
    }
    args[key.slice(2)] = value;
  }
  if (!args["expected-head"] || !args["output"]) fail("--expected-head and --output are required");
  return { expectedHead: args["expected-head"], output: args["output"] };
}

const { expectedHead: expectedHeadRaw, output } = parseArgs(process.argv);
const expectedHead = requireSha(expectedHeadRaw, "expected head");

const raw = process.env.REVIEW_JSON;
if (raw === undefined) fail("structured review output is missing");
if (Buffer.byteLength(raw, "utf8") > MAX_RESULT_BYTES)
  fail("structured review result is too large");

let payload;
try {
  payload = JSON.parse(raw);
} catch {
  fail("structured review result is not valid JSON");
}
if (
  payload === null ||
  typeof payload !== "object" ||
  Array.isArray(payload) ||
  Object.keys(payload).sort().join(",") !== EXPECTED_FIELDS.join(",")
) {
  fail("structured review result must contain exactly conclusion, details, and reviewed_head_sha");
}

const reviewedHead = requireSha(payload.reviewed_head_sha, "reviewed head");
if (reviewedHead !== expectedHead) fail("reviewed head is no longer the current PR head");

const conclusion = payload.conclusion;
if (typeof conclusion !== "string" || !CONCLUSIONS.has(conclusion)) {
  fail("conclusion must be PASS, FINDINGS, or INCOMPLETE");
}
let details = payload.details;
if (typeof details !== "string") fail("details must be a string");
for (const character of details) {
  const code = character.codePointAt(0);
  if (
    (code < 32 && character !== "\n" && character !== "\r" && character !== "\t") ||
    code === 127
  ) {
    fail("details contain a forbidden control character");
  }
}
details = details.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
if (Buffer.byteLength(details, "utf8") > MAX_DETAILS_BYTES) fail("review details are too large");

const heading = `${HEADING_PREFIX} — ${reviewedHead}`;
let body;
if (conclusion === "PASS") {
  if (details !== "") fail("PASS details must be empty");
  body = `${heading}\n\n${PASS_SENTENCE}\n`;
} else if (conclusion === "INCOMPLETE") {
  if (details === "") fail("INCOMPLETE details must explain what was missing");
  body = `${heading}\n\n${INCOMPLETE_SENTENCE}\n\n${details}\n`;
} else {
  if (details === "") fail("FINDINGS details must contain the findings");
  body = `${heading}\n\n${details}\n`;
}
if (Buffer.byteLength(body, "utf8") > MAX_COMMENT_BYTES)
  fail("rendered review comment is too large");

writeFileSync(output, JSON.stringify({ body }));
