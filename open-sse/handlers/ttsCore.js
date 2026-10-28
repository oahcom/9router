import { Buffer } from "node:buffer";
import { createErrorResult } from "../utils/error.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { getTtsAdapter, synthesizeViaConfig } from "./ttsProviders/index.js";

// Re-export voice fetchers + voices APIs for backward compat with existing routes
export {
  VOICE_FETCHERS,
  fetchEdgeTtsVoices,
  fetchLocalDeviceVoices,
  fetchElevenLabsVoices,
} from "./ttsProviders/index.js";

// ── Response Formatter (DRY) ───────────────────────────────────
function createTtsResponse(base64Audio, format, responseFormat) {
  const audioBuffer = Buffer.from(base64Audio, "base64");

  // JSON format: return base64 encoded audio
  if (responseFormat === "json") {
    return {
      success: true,
      response: new Response(JSON.stringify({ audio: base64Audio, format }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }),
    };
  }

  // Binary format (default): return raw audio
  return {
    success: true,
    response: new Response(audioBuffer, {
      headers: {
        "Content-Type": `audio/${format}`,
        "Content-Length": String(audioBuffer.length),
        "Access-Control-Allow-Origin": "*",
      },
    }),
  };
}

// ── Core handler ───────────────────────────────────────────────
/**
 * Synthesize text to audio. Provider logic lives in `./ttsProviders/{id}.js`
 * or is dispatched generically via `ttsConfig.format`.
 *
 * @returns {Promise<{success, response, status?, error?}>}
 */
export async function handleTtsCore({ provider, model, input, credentials, responseFormat = "mp3", language, style }) {
  if (!input?.trim()) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, "Missing required field: input");
  }

  try {
    // Special-case adapters — the authoritative list is SPECIAL_ADAPTERS in
    // ttsProviders/index.js (google-tts, edge-tts, local-device, elevenlabs, openai,
    // openrouter, gemini, xiaomi-mimo, selfhosted-tts, ollama-local). A provider with an
    // adapter returns here and never reaches synthesizeViaConfig, so it skips the
    // defaultModel fallback in ttsProviders/index.js — but the adapters still read the
    // same PROVIDER_MEDIA[id].ttsConfig.defaultModel to resolve their own default
    // (openai.js:5, openrouter.js:11, ollamaLocal.js:7). Editing a registry defaultModel
    // therefore does take effect; what it does not feed is that generic fallback.
    const adapter = getTtsAdapter(provider);
    if (adapter) {
      const result = await adapter.synthesize(input.trim(), model, credentials, responseFormat, { language, style });
      // Adapter may return a full {success, response} (legacy) or {base64, format}
      if (result.success !== undefined) return result;
      return createTtsResponse(result.base64, result.format, responseFormat);
    }

    // Generic config-driven (hyperbolic, deepgram, nvidia, huggingface, inworld, cartesia, playht, coqui, tortoise, qwen, ...)
    const result = await synthesizeViaConfig(provider, input.trim(), model, credentials);
    if (result) return createTtsResponse(result.base64, result.format, responseFormat);

    return createErrorResult(HTTP_STATUS.BAD_REQUEST, `Provider '${provider}' does not support TTS via this route.`);
  } catch (err) {
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, err.message || "TTS synthesis failed");
  }
}
