/**
 * Spoken replies through ElevenLabs.
 *
 * ElevenLabs speaks the answer out loud here; without a key the deployment is text-only. Key-gated on
 * `ELEVENLABS_API_KEY` with `ELEVENLABS_VOICE_ID` choosing the voice — without a key the
 * deployment is text-only and says so, rather than failing a turn over audio.
 *
 * Audio never touches the database: MP3 bytes travel from vendor to Telegram in memory and
 * are gone with the request. Text stays the transcript of record everywhere.
 */

export function voiceConfig(
  environment: Record<string, string | undefined> = process.env,
): { apiKey: string; voiceId: string; model: string } | null {
  const apiKey = environment.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    voiceId: environment.ELEVENLABS_VOICE_ID?.trim() || "21m00Tcm4TlvDq8ikWAM",
    model: environment.ELEVENLABS_MODEL?.trim() || "eleven_multilingual_v2",
  };
}

/** MP3 bytes for the text, or null when unavailable. Never throws. */
export async function synthesizeSpeech(
  text: string,
  config: {
    apiKey: string;
    voiceId: string;
    model: string;
  } | null = voiceConfig(),
): Promise<Uint8Array | null> {
  const clean = text.trim().slice(0, 2000);
  if (!config || !clean) return null;
  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${config.voiceId}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "xi-api-key": config.apiKey,
        },
        body: JSON.stringify({
          text: clean,
          model_id: config.model,
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer().catch(() => null);
    if (!buffer || buffer.byteLength === 0) return null;
    return new Uint8Array(buffer);
  } catch {
    return null;
  }
}
