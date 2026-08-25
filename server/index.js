import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import { classifyImage, hashBuffer } from "./classify.js";
import { computeDHash, groupNearDuplicates } from "./phash.js";

const app = express();
const PORT = process.env.PORT || 3001;
const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB || 10);
const MAX_SESSION_SIZE_MB = Number(process.env.MAX_SESSION_SIZE_MB || 50);
const NEAR_DUP_THRESHOLD = Number(process.env.NEAR_DUP_HAMMING_THRESHOLD || 8);

app.use(cors());
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(), // never written to disk
  limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024 },
});

app.get("/health", (_req, res) => res.json({ ok: true }));

/**
 * POST /classify
 * multipart/form-data, field name "files" (multiple allowed)
 *
 * Files are processed in-memory only and never persisted to disk or DB.
 * Only the classification result (metadata) is returned to the client.
 *
 * Duplicate detection has two tiers, deliberately treated differently:
 *  - EXACT duplicates (identical bytes, SHA-256 match) -> safe to
 *    auto-suggest "delete", since it's provably the same file.
 *  - NEAR duplicates (visually similar, e.g. resized/re-compressed/
 *    cropped, via perceptual hashing) -> flagged for the user to
 *    compare side-by-side, but NEVER auto-suggested for deletion —
 *    they could be meaningfully different (e.g. a cropped ID vs. the
 *    original), so only a human should decide.
 */
app.post("/classify", upload.array("files"), async (req, res) => {
  const files = req.files || [];

  if (files.length === 0) {
    return res.status(400).json({ error: "No files provided." });
  }

  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  if (totalBytes > MAX_SESSION_SIZE_MB * 1024 * 1024) {
    return res.status(413).json({
      error: `Session upload exceeds ${MAX_SESSION_SIZE_MB}MB limit.`,
    });
  }

  const seenHashes = new Map();
  const results = [];
  const pendingClassification = []; // { file } — not exact dupes, needs LLM + phash

  // Pass 1: exact-duplicate detection (cheap, no I/O beyond hashing)
  for (const file of files) {
    const hash = hashBuffer(file.buffer);
    const isExactDuplicateOf = seenHashes.get(hash);
    if (!isExactDuplicateOf) seenHashes.set(hash, file.originalname);

    if (isExactDuplicateOf) {
      results.push({
        filename: file.originalname,
        category: "duplicate",
        reasoning: `Exact duplicate of "${isExactDuplicateOf}".`,
        suggestion: "delete",
        confidence: 1,
        sizeBytes: file.size,
        duplicateType: "exact",
      });
      continue;
    }

    if (!file.mimetype.startsWith("image/")) {
      // Hackathon scope: only images go through vision classification.
      results.push({
        filename: file.originalname,
        category: "unsupported-type",
        reasoning: "Non-image file — not classified in this build.",
        suggestion: "keep",
        confidence: 0,
        sizeBytes: file.size,
      });
      continue;
    }

    pendingClassification.push(file);
  }

  // Pass 2: perceptual hashing for near-duplicate grouping among the
  // remaining images (exact dupes already handled above).
  const hashedImages = [];
  for (const file of pendingClassification) {
    try {
      const dHash = await computeDHash(file.buffer);
      hashedImages.push({ filename: file.originalname, hash: dHash });
    } catch (err) {
      console.error(`pHash failed for "${file.originalname}":`, err);
    }
  }
  const nearDuplicateMap = groupNearDuplicates(hashedImages, NEAR_DUP_THRESHOLD);

  // Pass 3: LLM classification for each remaining image, annotated with
  // any near-duplicate matches found above.
  const classifiedResults = await Promise.all(
    pendingClassification.map(async (file) => {
      const similarTo = nearDuplicateMap.get(file.originalname) || [];
      try {
        const base64 = file.buffer.toString("base64");
        const classification = await classifyImage({
          base64,
          mediaType: file.mimetype,
          filename: file.originalname,
        });

        const result = {
          filename: file.originalname,
          sizeBytes: file.size,
          ...classification,
        };

        if (similarTo.length > 0) {
          result.duplicateType = "near";
          result.similarTo = similarTo;
          result.reasoning = `${result.reasoning} Looks visually similar to ${similarTo.length} other file(s) — compare before deciding.`;
          // Never let a near-duplicate carry an auto "delete" suggestion —
          // it's only a visual similarity signal, not proof it's disposable.
          if (result.suggestion === "delete") result.suggestion = "archive";
        }

        return result;
      } catch (err) {
        console.error(`Classification failed for "${file.originalname}":`, err);
        return {
          filename: file.originalname,
          category: "error",
          reasoning: "Classification failed — please review manually.",
          suggestion: "keep",
          confidence: 0,
          sizeBytes: file.size,
          error: String(err.message || err),
          ...(similarTo.length > 0 ? { duplicateType: "near", similarTo } : {}),
        };
      }
    })
  );
  results.push(...classifiedResults);

  // file.buffer goes out of scope here and is garbage collected —
  // nothing from this request is written to disk.
  res.json({ results });
});

app.listen(PORT, () => {
  console.log(`Declutter server running on http://localhost:${PORT}`);
});
