import assert from "node:assert/strict";

const websocketUrl = process.env.TWENTY_CDP_URL;
assert.ok(websocketUrl, "Set TWENTY_CDP_URL to an authenticated page target");

const socket = new WebSocket(websocketUrl);
let nextId = 1;
const pending = new Map();
const findings = [];

const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const handler = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) handler.reject(new Error(JSON.stringify(message.error)));
    else handler.resolve(message.result);
    return;
  }

  if (message.method === "Runtime.exceptionThrown") {
    findings.push({
      kind: "exception",
      text:
        message.params.exceptionDetails.exception?.description ??
        message.params.exceptionDetails.text,
    });
  }

  if (
    message.method === "Runtime.consoleAPICalled" &&
    message.params.type === "error"
  ) {
    findings.push({
      kind: "console-error",
      text: message.params.args
        .map((argument) => argument.value ?? argument.description ?? "")
        .join(" "),
    });
  }

  if (
    message.method === "Log.entryAdded" &&
    message.params.entry.level === "error"
  ) {
    findings.push({
      kind: "log-error",
      text: message.params.entry.text,
      url: message.params.entry.url,
    });
  }

  if (
    message.method === "Network.responseReceived" &&
    message.params.response.status >= 500
  ) {
    findings.push({
      kind: "http-error",
      status: message.params.response.status,
      url: message.params.response.url,
    });
  }
});

await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

try {
  await Promise.all([
    call("Runtime.enable"),
    call("Log.enable"),
    call("Network.enable"),
    call("Page.enable"),
  ]);
  await call("Page.reload", { ignoreCache: true });
  await new Promise((resolve) => setTimeout(resolve, 10_000));

  console.log(JSON.stringify({ ok: findings.length === 0, findings }, null, 2));
  assert.deepEqual(findings, [], "Browser console or HTTP 5xx errors detected");
} finally {
  socket.close();
}
