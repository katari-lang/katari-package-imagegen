// The sidecar half of `imagegen.ktr` — one Gemini image-model call per edit. The input image's bytes
// come over the blob side channel (`image.bytes()`), the instruction + image go to generateContent,
// and the FIRST image part of the response uploads back over the same side channel (`context.file`)
// so the handler returns a real `file` value. A response with no image part (the model refused, or
// answered in text) throws with that text, which surfaces to the model as the tool's error result.

import { katari, type KatariFile } from "@katari-lang/port";

katari.agent<{ image: KatariFile; instruction: string; model: string; api_key: string }>(
  "gemini_image_edit",
  async ({ image, instruction, model, api_key }, context) => {
    const bytes = await image.bytes();
    const mimeType = (await image.contentType()) ?? "image/png";
    const body = {
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                mimeType,
                data: Buffer.from(bytes).toString("base64"),
              },
            },
            { text: instruction },
          ],
        },
      ],
    };
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": api_key },
        body: JSON.stringify(body),
        signal: context.signal,
      },
    );
    if (!response.ok) {
      throw new Error(`image edit failed: ${response.status} ${await response.text()}`);
    }
    const parsed = (await response.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }> };
      }>;
    };
    const parts = parsed.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      if (part.inlineData?.data !== undefined) {
        return context.file(new Uint8Array(Buffer.from(part.inlineData.data, "base64")), {
          contentType: part.inlineData.mimeType ?? "image/png",
        });
      }
    }
    // No image came back — surface whatever the model said instead (a refusal, a clarification).
    const texts = parts.flatMap((part) => (part.text === undefined ? [] : [part.text]));
    throw new Error(
      texts.length > 0 ? `image edit returned no image: ${texts.join(" ")}` : "image edit returned no image",
    );
  },
);
