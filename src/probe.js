import { createApp } from "./app.js";
import { findModel, getActiveProfile } from "./config-store.js";
import { HttpError } from "./errors.js";

export async function probeActiveProfile(config, prompt = "Reply with one short sentence.") {
  const { name, profile } = await getActiveProfile(config);
  const model = findModel(profile);
  if (!model) {
    throw new HttpError(400, `Active profile "${name}" has no models`, "bad_config");
  }

  const app = createApp({ config });
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: model.id,
      messages: [{ role: "user", content: prompt }]
    })
  });

  const body = JSON.parse(response.body);
  if (response.status !== 200) {
    throw new HttpError(response.status, body.error?.message || "Probe failed", body.error?.type || "probe_failed");
  }

  return {
    profile: name,
    model: body.model,
    finishReason: body.choices?.[0]?.finish_reason,
    message: body.choices?.[0]?.message
  };
}
