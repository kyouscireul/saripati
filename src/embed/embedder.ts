import { pipeline, env, type FeatureExtractionPipeline } from "@xenova/transformers";
import { EMBEDDING_DIM } from "../db/schema.js";
import { resolvePaths } from "../config.js";

/**
 * Bundled, in-process embeddings via transformers.js running all-MiniLM-L6-v2.
 * No external service, no API key. The ~90 MB model downloads once on first use
 * and is cached under <dataDir>/models forever after (offline thereafter).
 *
 * Vectors are mean-pooled and L2-normalized, so the vault's default L2 KNN
 * (sqlite-vec) ranks identically to cosine similarity.
 */

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

let pipePromise: Promise<FeatureExtractionPipeline> | null = null;

function getPipeline(): Promise<FeatureExtractionPipeline> {
  if (!pipePromise) {
    const { modelCacheDir } = resolvePaths();
    env.cacheDir = modelCacheDir;
    // Resolve strictly by model id from cache/remote — no local-path guessing.
    env.allowLocalModels = false;
    pipePromise = pipeline("feature-extraction", MODEL_ID) as Promise<FeatureExtractionPipeline>;
  }
  return pipePromise;
}

/** Embed a single string into a normalized 384-dim vector. */
export async function embed(text: string): Promise<number[]> {
  const extractor = await getPipeline();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  const vec = Array.from(output.data as Float32Array);
  if (vec.length !== EMBEDDING_DIM) {
    throw new Error(`Embedding dim mismatch: got ${vec.length}, expected ${EMBEDDING_DIM}`);
  }
  return vec;
}

/** Pre-load the model (e.g. at MCP server start) so the first tool call is fast. */
export async function warmup(): Promise<void> {
  await getPipeline();
}
