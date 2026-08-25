import crypto from "node:crypto";

const CATEGORIES = [
  "receipt/finance",
  "screenshot-of-text/notes",
  "meme/social",
  "code/dev-reference",
  "document/PDF",
  "UI-reference/design",
  "travel/booking",
  "photo/personal",
  "other/unclear",
];

/**
 * Hash a file buffer to detect exact duplicates cheaply,
 * before ever calling the LLM.
 */
export function hashBuffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * Ask Claude to classify a single image: category, one-line reasoning,
 * and a confidence score. Low confidence should route to "needs review"
 * on the client rather than a suggested delete.
 */
export async function classifyImage({ base64, mediaType, filename }) {
  const systemPrompt = `You are a careful file-declutter assistant. You will be shown one image (often a screenshot, receipt, or document). Classify it and explain, in one short plain-language sentence, why it is likely still needed or likely safe to delete/archive.

Categories to choose from: ${CATEGORIES.join(", ")}.

Respond with ONLY minified JSON, no markdown fences, no preamble, in exactly this shape:
{"category":"<one of the categories>","reasoning":"<one short sentence, plain language>","suggestion":"keep|archive|delete","confidence":<0-1 number>}

Be conservative: if you are not confident, use a lower confidence score and prefer "keep" or "archive" over "delete". Never suggest "delete" for anything that looks like an ID, ticket, boarding pass, receipt with a future or recent date, or financial document, unless you are highly confident it is expired/no longer needed.`;

  const model = "gemini-3.6-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [
        {
          role: "user",
          parts: [
            { inline_data: { mime_type: mediaType, data: base64 } },
            { text: `Filename: ${filename}` },
          ],
        },
      ],
      generationConfig: { maxOutputTokens: 1024, temperature: 0.2 },    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const raw = (data.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();

    try {
    // Extract the first {...} block in case the model added any stray
    // text or markdown fences around the JSON.
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON object found in model response");
    const parsed = JSON.parse(match[0]);
    return {
      category: parsed.category || "other/unclear",
      reasoning: parsed.reasoning || "Unable to determine.",
      suggestion: parsed.suggestion || "keep",
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.3,
    };
  } catch (parseErr) {
    console.error(`Could not parse Gemini response for "${filename}". Raw output was:`, raw);
    // Fail safe: never guess a delete if parsing fails
    return {
      category: "other/unclear",
      reasoning: "Could not analyze this file confidently — please review manually.",
      suggestion: "keep",
      confidence: 0,
    };
  }
}