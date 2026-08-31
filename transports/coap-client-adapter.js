const { EventEmitter } = require("events");
const coap = require("coap");

const MAX_PAYLOAD_BYTES = 64 * 1024;

class CoapClientAdapter extends EventEmitter {
  constructor(options) {
    super();
    this.deviceId = options.deviceId;
    this.backendUrl = new URL(options.backendUrl);
    this.listenHost = options.listenHost;
    this.listenPort = options.listenPort;
    this.advertisedHost = options.advertisedHost;
    this.responseTopic = options.responseTopic;
    this.commandTopic = options.commandTopic;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.connected = false;
    this.pendingCommandResponse = null;

    this.server = coap.createServer((request, response) => {
      this.handleCommandRequest(request, response);
    });
    this.server.on("error", (error) => this.emit("error", error));
    this.server.listen(this.listenPort, this.listenHost, () => {
      this.connected = true;
      this.emit("connect");
    });
  }

  subscribe(topic, callback) {
    this.commandTopic = topic;
    queueMicrotask(() => callback?.(null));
  }

  publish(topic, payload, options, callback) {
    const normalizedCallback =
      typeof options === "function" ? options : callback;

    if (topic === this.responseTopic && this.pendingCommandResponse) {
      this.finishCommandResponse(payload, normalizedCallback);
      return;
    }

    const kind = this.kindFromTopic(topic);
    if (!kind) {
      const error = new Error(`COAP_TOPIC_UNSUPPORTED:${topic}`);
      this.reportPublishResult(error, normalizedCallback);
      return;
    }

    let body = Buffer.isBuffer(payload)
      ? payload.toString("utf8")
      : String(payload);

    if (kind === "status") {
      try {
        const status = JSON.parse(body);
        if (String(status.status).toLowerCase() === "online") {
          status.commandEndpoint = this.commandEndpoint();
          body = JSON.stringify(status);
        }
      } catch (error) {
        this.reportPublishResult(error, normalizedCallback);
        return;
      }
    }

    this.postToBackend(kind, body, normalizedCallback);
  }

  end(force, options, callback) {
    const normalizedCallback =
      typeof force === "function"
        ? force
        : typeof options === "function"
          ? options
          : callback;

    if (!this.server) {
      this.connected = false;
      normalizedCallback?.();
      return;
    }

    const server = this.server;
    this.server = null;
    this.connected = false;

    if (this.pendingCommandResponse) {
      this.respond(
        this.pendingCommandResponse.response,
        "5.03",
        { error: "COAP_SIMULATOR_SHUTTING_DOWN" }
      );
      clearTimeout(this.pendingCommandResponse.timer);
      this.pendingCommandResponse = null;
    }

    server.close(() => normalizedCallback?.());
  }

  kindFromTopic(topic) {
    if (topic.endsWith("/telemetry")) return "telemetry";
    if (topic.endsWith("/attributes")) return "attributes";
    if (topic.endsWith("/status")) return "status";
    return null;
  }

  commandEndpoint() {
    return `coap://${this.advertisedHost}:${this.boundPort()}/commands`;
  }

  boundPort() {
    const address = this.server?._sock?.address?.();
    return address?.port || this.listenPort;
  }

  postToBackend(kind, body, callback) {
    if (Buffer.byteLength(body, "utf8") > MAX_PAYLOAD_BYTES) {
      this.reportPublishResult(
        new Error("COAP_PAYLOAD_TOO_LARGE"),
        callback
      );
      return;
    }

    const request = coap.request({
      hostname: this.backendUrl.hostname,
      port: Number(this.backendUrl.port || 5683),
      pathname: `/devices/${encodeURIComponent(this.deviceId)}/${kind}`,
      method: "POST",
      confirmable: true,
    });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this.reportPublishResult(error, callback);
    };
    const timer = setTimeout(() => {
      request.abort();
      finish(new Error(`COAP_BACKEND_TIMEOUT:${kind}`));
    }, this.requestTimeoutMs);

    request.setOption("Content-Format", "application/json");
    request.setOption("Accept", "application/json");
    request.once("error", finish);
    request.once("response", (response) => {
      response.once("end", () => {
        if (!String(response.code || "").startsWith("2.")) {
          finish(new Error(`COAP_BACKEND_REJECTED:${response.code}`));
          return;
        }
        finish(null);
      });
      response.resume();
    });
    request.end(body);
  }

  handleCommandRequest(request, response) {
    if (request.method !== "POST") {
      this.respond(response, "4.05", { error: "METHOD_NOT_ALLOWED" });
      return;
    }

    if (request.url !== "/commands") {
      this.respond(response, "4.04", { error: "COAP_ROUTE_NOT_FOUND" });
      return;
    }

    if (this.pendingCommandResponse) {
      this.respond(response, "5.03", { error: "COMMAND_ALREADY_IN_PROGRESS" });
      return;
    }

    this.readRequestBody(request, (error, body) => {
      if (error) {
        this.respond(response, "4.00", { error: error.message });
        return;
      }

      const timer = setTimeout(() => {
        if (this.pendingCommandResponse?.response !== response) return;
        this.pendingCommandResponse = null;
        this.respond(response, "5.04", { error: "COMMAND_HANDLER_TIMEOUT" });
      }, this.requestTimeoutMs);

      this.pendingCommandResponse = { response, timer };
      this.emit("message", this.commandTopic, Buffer.from(body, "utf8"));
    });
  }

  readRequestBody(request, callback) {
    if (Buffer.isBuffer(request.payload)) {
      this.validateRequestBody(request.payload, callback);
      return;
    }

    const chunks = [];
    let bytes = 0;

    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes <= MAX_PAYLOAD_BYTES) chunks.push(chunk);
    });
    request.once("error", callback);
    request.once("end", () => {
      if (bytes > MAX_PAYLOAD_BYTES) {
        callback(new Error("COAP_COMMAND_TOO_LARGE"));
        return;
      }

      this.validateRequestBody(
        Buffer.concat(chunks, bytes),
        callback
      );
    });
  }

  validateRequestBody(payload, callback) {
    if (payload.length > MAX_PAYLOAD_BYTES) {
      callback(new Error("COAP_COMMAND_TOO_LARGE"));
      return;
    }

    const body = payload.toString("utf8");
    try {
      JSON.parse(body);
      callback(null, body);
    } catch {
      callback(new Error("COAP_COMMAND_INVALID_JSON"));
    }
  }

  finishCommandResponse(payload, callback) {
    const pending = this.pendingCommandResponse;
    this.pendingCommandResponse = null;
    clearTimeout(pending.timer);

    try {
      const body = Buffer.isBuffer(payload)
        ? payload.toString("utf8")
        : String(payload);
      const parsed = JSON.parse(body);
      // A valid command response is a successful CoAP exchange even when the
      // device reports an application-level failure in `success`.
      this.respond(pending.response, "2.05", parsed);
      callback?.(null);
    } catch (error) {
      this.respond(pending.response, "5.00", {
        error: "COAP_COMMAND_RESPONSE_INVALID",
      });
      this.reportPublishResult(error, callback);
    }
  }

  reportPublishResult(error, callback) {
    if (callback) {
      callback(error || null);
      return;
    }
    if (error) this.emit("error", error);
  }

  respond(response, code, body) {
    if (response.finished) return;
    response.code = code;
    response.setOption("Content-Format", "application/json");
    response.end(JSON.stringify(body));
  }
}

function createCoapClientAdapter(options) {
  return new CoapClientAdapter({
    backendUrl: "coap://127.0.0.1:5683",
    listenHost: "127.0.0.1",
    listenPort: 5684,
    advertisedHost: "127.0.0.1",
    requestTimeoutMs: 10_000,
    ...options,
  });
}

module.exports = { createCoapClientAdapter };
