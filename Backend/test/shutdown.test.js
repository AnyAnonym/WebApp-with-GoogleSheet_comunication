const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { setTestEnvironment } = require("./helpers.js");

setTestEnvironment();
process.env.SHUTDOWN_GRACE_MS = "1000";
const { createApplication } = require("../server.js");
const { StateRepository } = require("../stateRepository.js");

function responseRecorder() {
  return {
    headersSent: false,
    statusCode: null,
    body: "",
    writeHead(status) {
      this.statusCode = status;
      this.headersSent = true;
    },
    end(body = "") { this.body += body; },
    destroy() {},
  };
}

test("Shutdown lehnt neue Operationen ab und schliesst akzeptierte Drains vor dem Repository", async () => {
  const repository = new StateRepository(":memory:");
  let releaseStop;
  const stopGate = new Promise((resolve) => { releaseStop = resolve; });
  let stopStarted = false;
  const sheetService = {
    async setPasswordHash() {},
    status: () => ({ stopping: stopStarted, activeWrites: stopStarted ? 1 : 0, queues: 1 }),
    async stop() {
      stopStarted = true;
      await stopGate;
    },
  };
  const application = createApplication({ repository, sheetService });
  const shutdown = application.shutdown("test");
  assert.equal(application.status().shuttingDown, true);

  const request = Readable.from([]);
  request.method = "GET";
  request.url = "/api/session";
  request.headers = {};
  request.socket = { remoteAddress: "127.0.0.1" };
  const response = responseRecorder();
  await application.handler(request, response);
  assert.equal(response.statusCode, 503);
  assert.equal(JSON.parse(response.body).error.code, "SHUTTING_DOWN");

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopStarted, true);
  assert.equal(repository.status().open, true);
  releaseStop();
  await shutdown;
  assert.equal(repository.status().open, false);
  assert.equal(application.messagingRepository.status().open, false);
});
