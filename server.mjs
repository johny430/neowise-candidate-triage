import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify } from "./mock-ai.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));

export const AI_TIMEOUT_MS = 300;
const ALLOWED_TOPICS = new Set(["delivery", "pricing", "other"]);
const MAX_BODY_BYTES = 1024 * 1024;

function json(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function invalidInput(response) {
  return json(response, 400, { status: "invalid_input" });
}

function manualReview(response) {
  return json(response, 200, { status: "manual_review", topic: null, draft: null });
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseInput(raw) {
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  if (typeof body.text !== "string" || body.text.trim() === "") return null;
  return body.text;
}

async function requestTriage(text) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  try {
    const raw = await classify(text, { signal: controller.signal });
    if (typeof raw !== "string") return null;

    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (!ALLOWED_TOPICS.has(parsed.topic)) return null;
    if (typeof parsed.draft !== "string" || parsed.draft.trim() === "") return null;

    return { topic: parsed.topic, draft: parsed.draft };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function handleTriage(request, response) {
  let raw;
  try {
    raw = await readBody(request);
  } catch {
    return invalidInput(response);
  }

  const text = parseInput(raw);
  if (text === null) return invalidInput(response);

  const result = await requestTriage(text);
  if (result === null) return manualReview(response);

  return json(response, 200, {
    status: "ready",
    topic: result.topic,
    draft: result.draft,
  });
}

export function createApp() {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(html);
      return;
    }

    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }

    try {
      await handleTriage(request, response);
    } catch {
      if (response.headersSent) {
        response.end();
      } else {
        json(response, 500, { status: "server_error" });
      }
    }
  });
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) {
  const port = Number(process.env.PORT || 3000);
  const server = createApp();
  server.listen(port, "127.0.0.1", () => {
    const actualPort = server.address().port;
    console.log(`Listening on http://127.0.0.1:${actualPort}`);
  });
}
