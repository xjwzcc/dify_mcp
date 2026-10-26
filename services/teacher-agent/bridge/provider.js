/** Provider boundary added to the existing Bridge. ModelHub remains opt-in. */
const kind = process.env.UPSTREAM_PROVIDER || "deepseek";
if (!["deepseek", "modelhub"].includes(kind)) throw Error("Unknown provider");
const base = (kind === "deepseek"
  ? process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com"
  : process.env.MODELHUB_BASE || "").replace(/\/+$/, "");
if (!base) throw Error("MODELHUB_BASE is required for ModelHub");
const key = kind === "deepseek" ? process.env.DEEPSEEK_API_KEY : process.env.MODELHUB_AK;
const model = process.env.UPSTREAM_MODEL || process.env.MODELHUB_MODEL || "deepseek-flash";
function fail(message) { throw Object.assign(Error(message), {statusCode: 400}); }
export const provider = {
  kind, base, key, model, compact: kind === "modelhub",
  url(path = "responses") {
    return base + "/" + path + (kind === "modelhub" ? "?ak=" + encodeURIComponent(key) : "");
  },
  headers(session, logid) {
    return kind === "deepseek"
      ? {"content-type": "application/json", authorization: "Bearer " + key}
      : {"content-type": "application/json", "X-TT-LOGID": logid, extra: JSON.stringify({session_id: session})};
  },
  body(value, session, logid) {
    if (kind === "modelhub") return {...value, "X-TT-logid": logid, extra: JSON.stringify({session_id: session})};
    const body = {...value, model};
    delete body.previous_response_id;
    delete body.extra;
    if (body.reasoning) {
      const effort = body.reasoning.effort || "high";
      body.reasoning = {effort: ({minimal:"low",medium:"high",xhigh:"high",ultra:"max"})[effort] || effort};
    }
    body.input = (body.input || []).map(item => {
      if (item.type === "item_reference" || item.type === "compaction")
        fail("UNSUPPORTED_OPAQUE_HISTORY");
      const result = {...item};
      if (result.encrypted_content) {
        // DeepSeek returns both plaintext reasoning and an opaque companion.
        // Its stateless input accepts the plaintext content only. Never drop
        // opaque-only history: that would lose the reasoning needed by tools.
        if (result.type !== "reasoning" || !Array.isArray(result.content) ||
            !result.content.some(part => part.type === "reasoning_text" && typeof part.text === "string" && part.text.trim()))
          fail("UNSUPPORTED_OPAQUE_HISTORY");
        delete result.encrypted_content;
      }
      if (result.type === "reasoning") delete result.summary;
      if (result.role === "developer") result.role = "system";
      if (result.type === "function_call" && result.namespace) {
        result.name = result.namespace + result.name;
        delete result.namespace;
      }
      return result;
    });
    for (const tool of body.tools || []) {
      if (tool.type !== "function" && !(tool.type === "custom" && tool.name === "apply_patch"))
        fail("UNSUPPORTED_TOOL");
    }
    return body;
  }
};
