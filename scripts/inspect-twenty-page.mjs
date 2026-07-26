import assert from "node:assert/strict";
import WebSocket from "ws";

const websocketUrl = process.env.TWENTY_CDP_URL;
assert.ok(websocketUrl, "Set TWENTY_CDP_URL");
const testEmail = process.env.TWENTY_TEST_EMAIL ?? "tim@apple.dev";
const testPassword = process.env.TWENTY_TEST_PASSWORD ?? "tim@apple.dev";

const socket = new WebSocket(websocketUrl);
let nextId = 1;
const pending = new Map();
const events = [];
const trackedResponseIds = new Map();
const responseBodyTasks = [];
const MAX_PROTOCOL_EVENTS = 40;
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (!message.id) {
    if (
      message.method === "Network.requestWillBeSent" &&
      (message.params.request.method !== "GET" ||
        ["Fetch", "XHR"].includes(message.params.type))
    ) {
      events.push({
        kind: "request",
        method: message.params.request.method,
        resourceType: message.params.type,
        url: message.params.request.url.split("?")[0],
      });
    }
    if (
      message.method === "Network.responseReceived" &&
      (["Fetch", "XHR"].includes(message.params.type) ||
        message.params.response.status >= 400 ||
        /graphql|auth|sign-in|sign-up/i.test(message.params.response.url))
    ) {
      events.push({
        kind: "response",
        resourceType: message.params.type,
        status: message.params.response.status,
        url: message.params.response.url.split("?")[0],
      });
      if (
        message.params.type === "Fetch" &&
        message.params.response.url.split("?")[0].endsWith("/metadata")
      ) {
        trackedResponseIds.set(message.params.requestId, {
          status: message.params.response.status,
          url: message.params.response.url.split("?")[0],
        });
      }
    }
    if (
      message.method === "Network.loadingFinished" &&
      trackedResponseIds.has(message.params.requestId)
    ) {
      const response = trackedResponseIds.get(message.params.requestId);
      trackedResponseIds.delete(message.params.requestId);
      responseBodyTasks.push(
        call("Network.getResponseBody", {
          requestId: message.params.requestId,
        })
          .then(({ body }) => {
            const payload = JSON.parse(body);
            if (!Array.isArray(payload.errors)) return;
            events.push({
              kind: "graphql-errors",
              status: response.status,
              url: response.url,
              errors: payload.errors.slice(0, 5).map((error) => ({
                message: String(error.message ?? "Unknown GraphQL error").slice(
                  0,
                  300,
                ),
                code:
                  typeof error.extensions?.code === "string"
                    ? error.extensions.code
                    : undefined,
              })),
            });
          })
          .catch(() => undefined),
      );
    }
    if (message.method === "Runtime.exceptionThrown") {
      events.push({
        kind: "exception",
        text: message.params.exceptionDetails.text,
      });
    }
    return;
  }
  if (!pending.has(message.id)) return;
  const handler = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) handler.reject(new Error(JSON.stringify(message.error)));
  else handler.resolve(message.result);
});

await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

try {
  await Promise.all([
    call("Runtime.enable"),
    call("Network.enable"),
    call("Page.enable"),
  ]);
  const evaluate = (expression) =>
    call("Runtime.evaluate", { expression, returnByValue: true });
  const waitFor = async (expression, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await evaluate(expression);
      if (result.result.value) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`timed out waiting for: ${expression}`);
  };
  const clickButton = async (label) => {
    const location = await evaluate(`(() => {
      const button = [...document.querySelectorAll("button")].find(
        (candidate) => candidate.innerText.trim() === ${JSON.stringify(label)});
      if (!button) return null;
      const rect = button.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    assert.ok(location.result.value, `Button not found: ${label}`);
    const { x, y } = location.result.value;
    await call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await call("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await call("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  };
  if (process.env.TWENTY_INSPECT_ACTION === "continue-email") {
    await call("Runtime.evaluate", {
      expression: `[...document.querySelectorAll("button")].find(
        (button) => button.innerText.includes("Continue with Email")
      )?.click()`,
    });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  if (process.env.TWENTY_INSPECT_ACTION === "submit-demo-email") {
    await call("Runtime.evaluate", {
      expression: `(() => {
        const input = document.querySelector('input[autocomplete="email"]');
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype, "value").set;
        setter.call(input, "tim@apple.dev");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        [...document.querySelectorAll("button")].find(
          (button) => ["Continue", "Sign up"].includes(
            button.innerText.trim()))?.click();
      })()`,
    });
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  if (process.env.TWENTY_INSPECT_ACTION === "submit-demo-password") {
    await call("Runtime.evaluate", {
      expression: `(() => {
        const input = document.querySelector('input[type="password"]');
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype, "value").set;
        setter.call(input, "tim@apple.dev");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        [...document.querySelectorAll("button")].find(
          (button) => ["Continue", "Sign up"].includes(
            button.innerText.trim()))?.click();
      })()`,
    });
    await new Promise((resolve) => setTimeout(resolve, 8_000));
  }
  if (process.env.TWENTY_INSPECT_ACTION === "submit-current-sign-in") {
    await evaluate(`document.querySelector('input[type="password"]')?.focus()`);
    await clickButton("Sign in");
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  if (process.env.TWENTY_INSPECT_ACTION === "create-workspace") {
    await evaluate(`document.querySelector(
      'input[placeholder="Apple"]')?.select()`);
    await call("Input.insertText", { text: "Canary G3 Workspace" });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await clickButton("Create workspace");
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
  if (process.env.TWENTY_INSPECT_ACTION === "create-profile") {
    for (const [placeholder, value] of [
      ["Tim", "Canary"],
      ["Apple", "Operator"],
      ["Head of Partnerships", "Reliability Test"],
    ]) {
      await evaluate(`document.querySelector(
        'input[placeholder=${JSON.stringify(placeholder)}]')?.select()`);
      await call("Input.insertText", { text: value });
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await clickButton("Continue");
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  if (process.env.TWENTY_INSPECT_ACTION === "click-continue") {
    await evaluate(`[...document.querySelectorAll("button")].find(
      (button) => button.innerText.trim() === "Continue")?.click()`);
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  if (process.env.TWENTY_INSPECT_ACTION === "click-skip") {
    await evaluate(`[...document.querySelectorAll("button")].find(
      (button) => button.innerText.trim() === "Skip")?.click()`);
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  if (process.env.TWENTY_INSPECT_ACTION === "reload-session") {
    await call("Page.reload", { ignoreCache: true });
    await waitFor(`document.readyState === "complete"`, 5 * 60_000);
    await new Promise((resolve) => setTimeout(resolve, 20_000));
  }
  if (process.env.TWENTY_INSPECT_ACTION === "open-workspace-menu") {
    await evaluate(`[...document.querySelectorAll('[role="button"]')].find(
      (button) => button.innerText.includes("Canary G3 Workspace"))?.click()`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  if (process.env.TWENTY_INSPECT_ACTION === "open-profile-settings") {
    await call("Page.navigate", {
      url: "https://twenty-crm-redis-free-canary.rikitrader.workers.dev/settings/profile",
    });
    await waitFor(`document.readyState === "complete"`);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  if (process.env.TWENTY_INSPECT_ACTION === "logout") {
    await clickButton("Logout");
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  if (process.env.TWENTY_INSPECT_ACTION === "demo-auth-flow") {
    await evaluate(`localStorage.clear()`);
    await call("Page.navigate", {
      url: "https://twenty-crm-redis-free-canary.rikitrader.workers.dev/",
    });
    await waitFor(`document.body?.innerText?.includes("Continue with Email")`);
    await evaluate(`[...document.querySelectorAll("button")].find(
      (button) => button.innerText.includes("Continue with Email"))?.click()`);
    await waitFor(`Boolean(document.querySelector(
      'input[autocomplete="email"]'))`);
    await evaluate(`document.querySelector(
      'input[autocomplete="email"]')?.select()`);
    await call("Input.insertText", { text: testEmail });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await evaluate(`[...document.querySelectorAll("button")].find(
      (button) => button.innerText.trim() === "Continue")?.click()`);
    await waitFor(`Boolean(document.querySelector('input[type="password"]'))`);
    await evaluate(`document.querySelector('input[type="password"]')?.select()`);
    await call("Input.insertText", { text: testPassword });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const submitLabel = (await evaluate(`[...document.querySelectorAll("button")]
      .find((button) => ["Sign in", "Sign up"].includes(
        button.innerText.trim()))?.innerText.trim()`)).result.value;
    assert.ok(submitLabel, "Sign-in or sign-up button not found");
    await clickButton(submitLabel);
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  const result = await call("Runtime.evaluate", {
    expression: `JSON.stringify({
      url: location.href,
      title: document.title,
      text: document.body?.innerText?.slice(0, 4000) ?? "",
      inputs: [...document.querySelectorAll("input")].map((input) => ({
        type: input.type,
        name: input.name,
        placeholder: input.placeholder,
        autocomplete: input.autocomplete,
        valueLength: input.value.length,
        valid: input.validity.valid,
        disabled: input.disabled
      })),
      buttons: [...document.querySelectorAll("button")].map((button) => ({
        text: button.innerText.trim(),
        disabled: button.disabled
      })).filter((button) => button.text),
      roleButtons: [...document.querySelectorAll('[role="button"]')]
        .slice(0, 80).map((button) => ({
          text: button.innerText.trim().slice(0, 120),
          label: button.getAttribute("aria-label"),
          title: button.getAttribute("title")
        })).filter((button) => button.text || button.label || button.title),
      links: [...document.querySelectorAll("a")].map((link) => ({
        text: link.innerText.trim(),
        href: link.getAttribute("href")
      })).filter((link) => link.text),
      localStorageKeys: Object.keys(localStorage),
      sessionStorageKeys: Object.keys(sessionStorage),
      recentResources: performance.getEntriesByType("resource").slice(-20)
        .map((entry) => entry.name.split("?")[0])
    })`,
    returnByValue: true,
  });
  await Promise.allSettled(responseBodyTasks);
  console.log(
    JSON.stringify(
      {
        ...JSON.parse(result.result.value),
        protocolEventCount: events.length,
        protocolEvents: events.slice(-MAX_PROTOCOL_EVENTS),
      },
      null,
      2,
    ),
  );
} finally {
  socket.close();
}
