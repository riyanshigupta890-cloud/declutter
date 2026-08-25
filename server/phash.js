import sharp from "sharp";

/**
 * Computes a difference hash (dHash) for an image: a compact fingerprint
 * that stays similar for visually similar images (resized, re-compressed,
 * slightly cropped, different format) even when the exact bytes differ.
 *
 * Unlike SHA-256 (used for exact-duplicate detection), this is NOT exact —
 * it only tells you two images are visually alike, not identical. That's
 * why near-duplicates are surfaced as "review" suggestions, never as an
 * automatic "delete".
 */
export async function computeDHash(buffer) {
  // Shrink to a tiny 9x8 grayscale image — enough signal to compare
  // perceptual similarity, small enough to hash fast.
  const { data } = await sharp(buffer)
    .grayscale()
    .resize(9, 8, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  let hash = "";
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const left = data[row * 9 + col];
      const right = data[row * 9 + col + 1];
      hash += left > right ? "1" : "0";
    }
  }
  return hash; // 64-bit binary string
}

/** Hamming distance between two equal-length binary hash strings. */
export function hammingDistance(hashA, hashB) {
  let distance = 0;
  for (let i = 0; i < hashA.length; i++) {
    if (hashA[i] !== hashB[i]) distance++;
  }
  return distance;
}

/**
 * Groups a list of { filename, hash } items into near-duplicate clusters.
 * Two images are considered "similar" if their dHash differs by at most
 * `threshold` bits out of 64 (8 is a good default — tight enough to avoid
 * false positives, loose enough to catch resizes/re-compressions/crops).
 *
 * Returns a Map from filename -> array of other filenames it's similar to.
 */
export function groupNearDuplicates(items, threshold = 8) {
  const similarityMap = new Map();
  for (const item of items) similarityMap.set(item.filename, []);

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const distance = hammingDistance(items[i].hash, items[j].hash);
      if (distance <= threshold) {
        similarityMap.get(items[i].filename).push(items[j].filename);
        similarityMap.get(items[j].filename).push(items[i].filename);
      }
    }
  }
  return similarityMap;
}
