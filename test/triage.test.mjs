import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server.mjs";

let server;
let baseUrl;

before(async () => {
  server = createApp();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function postTriage(body) {
  return fetch(`${baseUrl}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("valid request returns a ready triage result", async () => {
  const response = await postTriage({ text: "Когда доставите заказ?" });
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.status, "ready");
  assert.equal(body.topic, "delivery");
  assert.equal(typeof body.draft, "string");
  assert.ok(body.draft.trim().length > 0);
});

test("all supported topics are accepted", async () => {
  const cases = [
    ["Когда доставите заказ?", "delivery"],
    ["Какая стоимость доставки?", "pricing"],
    ["Здравствуйте, у меня вопрос.", "other"],
  ];

  for (const [text, expectedTopic] of cases) {
    const response = await postTriage({ text });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "ready",
      topic: expectedTopic,
      draft: "Спасибо за обращение. Уточним детали заявки.",
    });
  }
});

test("invalid input returns HTTP 400", async () => {
  const cases = [
    ["empty text", { text: "" }],
    ["whitespace text", { text: "   \n\t " }],
    ["missing text", {}],
    ["non-string text", { text: 42 }],
    ["null body", null],
    ["array body", []],
    ["broken JSON", '{"text":'],
    ["empty body", ""],
  ];

  for (const [name, body] of cases) {
    const response = await postTriage(body);
    assert.equal(response.status, 400, name);
    assert.deepEqual(await response.json(), { status: "invalid_input" }, name);
  }
});

test("model failures fall back to manual review", async () => {
  const cases = ["[error] заявка", "[bad-json] заявка", "[bad-topic] заявка", "[empty-draft] заявка"];

  for (const text of cases) {
    const response = await postTriage({ text });
    assert.equal(response.status, 200, text);
    assert.deepEqual(
      await response.json(),
      { status: "manual_review", topic: null, draft: null },
      text,
    );
  }
});

test("model timeout falls back to manual review within the 300 ms budget", async () => {
  const started = performance.now();
  const response = await postTriage({ text: "[timeout] заявка" });
  const elapsed = performance.now() - started;

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "manual_review",
    topic: null,
    draft: null,
  });
  assert.ok(elapsed >= 250 && elapsed < 800, `timeout took ${Math.round(elapsed)} ms`);
});

test("unknown routes return 404", async () => {
  const response = await fetch(`${baseUrl}/api/unknown`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { status: "not_found" });
});

test("the page is served with the triage form", async () => {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(await response.text(), /id="triage-form"/);
});
