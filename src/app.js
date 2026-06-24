import { getActiveProfile, listExposedModels, listProfiles, switchProfile, resolveModelRoute } from "./config-store.js";
import { errorBody, HttpError } from "./errors.js";
import { runProvider } from "./adapters.js";
import {
  anthropicMessageResponse,
  anthropicProviderRequest,
  chatCompletionResponse,
  modelResponse,
  modelsResponse,
  responseInputItemList,
  responseInputItems,
  responseObject,
  responseProviderRequest,
  streamAnthropicMessage,
  streamChatCompletionResponse,
  streamResponseObject
} from "./openai.js";
import { createLimiter } from "./queue.js";

export function createApp({ config }) {
  const limitProviderRequest = createLimiter(config.maxConcurrentRequests ?? 1);
  const responseStore = new Map();

  return {
    async inject({ method, url, body, headers = {} }) {
      return await handleRequest(config, limitProviderRequest, responseStore, {
        method,
        url,
        headers,
        body: body || ""
      });
    },

    async nodeHandler(req, res) {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", async () => {
        const result = await handleRequest(config, limitProviderRequest, responseStore, {
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString()
        });
        res.statusCode = result.status;
        for (const [key, value] of Object.entries(result.headers)) {
          res.setHeader(key, value);
        }
        res.end(result.body);
      });
    }
  };
}

async function handleRequest(config, limitProviderRequest, responseStore, request) {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    const body = parseBody(request);

    if (request.method === "GET" && url.pathname === "/v1/models") {
      return json(200, modelsResponse(await listExposedModels(config)));
    }

    if (request.method === "GET" && url.pathname.startsWith("/v1/models/")) {
      const requestedModel = decodeURIComponent(url.pathname.slice("/v1/models/".length));
      const model = (await listExposedModels(config)).find((candidate) => candidate.id === requestedModel);
      if (!model) {
        throw new HttpError(404, `Model "${requestedModel}" not found`, "not_found");
      }
      return json(200, modelResponse(model));
    }

    if (url.pathname.startsWith("/admin/")) {
      assertAdminAuthorized(config, request);
    }

    if (request.method === "GET" && url.pathname === "/admin/profiles") {
      const { name } = await getActiveProfile(config);
      return json(200, { activeProfile: name, profiles: listProfiles(config) });
    }

    if (request.method === "GET" && url.pathname === "/admin/active") {
      const { name } = await getActiveProfile(config);
      return json(200, { profile: name });
    }

    if (request.method === "POST" && url.pathname === "/admin/switch") {
      if (!body?.profile) throw new HttpError(400, "Missing profile", "bad_request");
      const state = await switchProfile(config, body.profile);
      return json(200, { profile: state.activeProfile, updatedAt: state.updatedAt });
    }

    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      return await limitProviderRequest(() => chatCompletions(config, body));
    }

    if (request.method === "POST" && url.pathname === "/v1/messages") {
      return await limitProviderRequest(() => anthropicMessages(config, body));
    }

    if (request.method === "POST" && url.pathname === "/v1/responses") {
      return await limitProviderRequest(() => responsesCreate(config, responseStore, body));
    }

    if (url.pathname.startsWith("/v1/responses/")) {
      const [responseId, child] = url.pathname
        .slice("/v1/responses/".length)
        .split("/")
        .map((part) => decodeURIComponent(part));
      if (request.method === "GET" && child === "input_items") {
        return json(200, responseInputItemList(storedResponseRecord(responseStore, responseId).inputItems));
      }
      if (request.method === "GET" && !child) {
        return json(200, storedResponse(responseStore, responseId));
      }
      if (request.method === "DELETE" && !child) {
        storedResponse(responseStore, responseId);
        responseStore.delete(responseId);
        return json(200, { id: responseId, object: "response", deleted: true });
      }
    }

    return json(404, { error: { message: "Not found", type: "not_found" } });
  } catch (error) {
    const status = error.statusCode || 500;
    return json(status, errorBody(error));
  }
}

function assertAdminAuthorized(config, request) {
  const expected = process.env.BRIDGE_ADMIN_TOKEN || config.adminToken;
  if (!expected) return;

  const authorization = headerValue(request.headers, "authorization");
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
  const token = bearer || headerValue(request.headers, "x-bridge-admin-token");
  if (token === expected) return;

  throw new HttpError(401, "Unauthorized", "unauthorized");
}

async function chatCompletions(config, body) {
  if (!body || typeof body !== "object") {
    throw new HttpError(400, "Request body must be a JSON object", "bad_request");
  }
  if (!Array.isArray(body.messages)) {
    throw new HttpError(400, "Request body must include messages", "bad_request");
  }
  if (!body.model || typeof body.model !== "string") {
    throw new HttpError(400, "Request body must include model", "bad_request");
  }

  const { profileName, profile, model } = await resolveModelRoute(config, body.model);
  if (!model) {
    throw new HttpError(400, `Profile "${profileName}" has no models`, "bad_config");
  }
  if (body.model && model.id !== body.model) {
    throw new HttpError(400, `Model "${body.model}" is not available`, "bad_request");
  }

  const providerResult = await runProvider({
    config,
    profileName,
    profile,
    model,
    request: body
  });
  const response = chatCompletionResponse({ ...body, model: model.id }, providerResult);
  if (body.stream) {
    return eventStream(200, streamChatCompletionResponse(response));
  }
  return json(200, response);
}

async function anthropicMessages(config, body) {
  if (!body || typeof body !== "object") {
    throw new HttpError(400, "Request body must be a JSON object", "bad_request");
  }
  if (!body.model || typeof body.model !== "string") {
    throw new HttpError(400, "Request body must include model", "bad_request");
  }
  if (!Array.isArray(body.messages)) {
    throw new HttpError(400, "Request body must include messages", "bad_request");
  }

  const { profileName, profile, model } = await resolveModelRoute(config, body.model);
  if (!model) {
    throw new HttpError(400, `Profile "${profileName}" has no models`, "bad_config");
  }
  if (model.id !== body.model) {
    throw new HttpError(400, `Model "${body.model}" is not available`, "bad_request");
  }

  const providerRequest = anthropicProviderRequest({ ...body, model: model.id });
  const providerResult = await runProvider({
    config,
    profileName,
    profile,
    model,
    request: providerRequest
  });
  const response = anthropicMessageResponse({ ...body, model: model.id }, providerResult);
  if (body.stream) {
    return eventStream(200, streamAnthropicMessage(response));
  }
  return json(200, response);
}

async function responsesCreate(config, responseStore, body) {
  if (!body || typeof body !== "object") {
    throw new HttpError(400, "Request body must be a JSON object", "bad_request");
  }
  if (!body.model || typeof body.model !== "string") {
    throw new HttpError(400, "Request body must include model", "bad_request");
  }
  if (body.input === undefined && body.instructions === undefined) {
    throw new HttpError(400, "Request body must include input or instructions", "bad_request");
  }

  const { profileName, profile, model } = await resolveModelRoute(config, body.model);
  if (!model) {
    throw new HttpError(400, `Profile "${profileName}" has no models`, "bad_config");
  }
  if (model.id !== body.model) {
    throw new HttpError(400, `Model "${body.model}" is not available`, "bad_request");
  }

  const previousRecords = previousResponseRecords(responseStore, body.previous_response_id);
  const providerRequest = responseProviderRequest({ ...body, model: model.id }, previousRecords);
  const providerResult = await runProvider({
    config,
    profileName,
    profile,
    model,
    request: providerRequest
  });
  const response = responseObject({ ...body, model: model.id }, providerResult);
  if (response.store) {
    responseStore.set(response.id, {
      response,
      inputItems: responseInputItems(body.input),
      previousResponseId: body.previous_response_id || null
    });
  }
  if (body.stream) {
    return eventStream(200, streamResponseObject(response));
  }
  return json(200, response);
}

function storedResponse(responseStore, responseId) {
  return storedResponseRecord(responseStore, responseId).response;
}

function storedResponseRecord(responseStore, responseId) {
  const record = responseStore.get(responseId);
  if (!record) {
    throw new HttpError(404, `Response "${responseId}" not found`, "not_found");
  }
  return record;
}

function previousResponseRecords(responseStore, responseId) {
  if (!responseId) return [];
  const records = [];
  const seen = new Set();
  let currentId = responseId;

  while (currentId) {
    if (seen.has(currentId)) {
      throw new HttpError(400, `Circular previous_response_id chain at "${currentId}"`, "bad_request");
    }
    seen.add(currentId);
    const record = storedResponseRecord(responseStore, currentId);
    records.unshift(record);
    currentId = record.previousResponseId;
  }

  return records;
}

function parseBody(request) {
  if (!request.body) return undefined;
  const contentType = request.headers["content-type"] || request.headers["Content-Type"] || "";
  if (!contentType.includes("application/json")) return undefined;
  return JSON.parse(request.body);
}

function json(status, value) {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value)
  };
}

function eventStream(status, body) {
  return {
    status,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive"
    },
    body
  };
}

function headerValue(headers, name) {
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()];
}
