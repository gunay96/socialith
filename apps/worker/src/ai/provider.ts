import type { Env } from "@socialith/config";

/**
 * Abstraction over "generate a caption + hashtags for this content",
 * mirroring apps/api/src/lib/email/email.service.ts's EmailService
 * pattern — one interface, resolved by a single function, so a future
 * provider swap touches only this file. Unlike EmailService, there is no
 * honest no-op implementation here: a caption genuinely cannot be
 * generated without a real AI provider, so `resolveAiProvider` returns
 * `null` when unconfigured and callers (content-generation.processor.ts)
 * must treat that as a real failure, never a fabricated success.
 */
export interface GenerateCaptionInput {
  /** The content's existing caption, if any — given as context, not overwritten blindly. */
  existingCaption: string | null;
  /** Platform this generation targets, or null for a general/base caption. */
  platform: string | null;
}

export interface GenerateCaptionUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  /** Only present when both AI_PROVIDER_COST_PER_1K_PROMPT_TOKENS and AI_PROVIDER_COST_PER_1K_COMPLETION_TOKENS are configured — see resolveAiProvider. Cost tracking is explicitly "if feasible": no pricing config, no estimate, never a guessed number. */
  estimatedCostUsd: number | null;
}

export interface GenerateCaptionResult {
  caption: string;
  hashtags: string[];
  usage: GenerateCaptionUsage | null;
}

export interface AiContentProvider {
  generateCaption(input: GenerateCaptionInput): Promise<GenerateCaptionResult>;
}

/** Thrown when the provider call itself didn't finish within AI_PROVIDER_TIMEOUT_MS — content-generation.processor.ts's retry/backoff (BullMQ attempts) treats this like any other transient provider failure. */
export class AiProviderTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`AI provider request timed out after ${timeoutMs}ms.`);
    this.name = "AiProviderTimeoutError";
  }
}

/** Thrown on a real HTTP 429 from the provider — distinct from AiProviderTimeoutError so content-generation.processor.ts can record ERROR_CODES.RATE_LIMITED specifically rather than a generic failure. */
export class AiProviderRateLimitError extends Error {
  constructor(
    message: string,
    public readonly retryAfterSeconds: number | undefined,
  ) {
    super(message);
    this.name = "AiProviderRateLimitError";
  }
}

export interface CostConfig {
  costPer1kPromptTokensUsd: number;
  costPer1kCompletionTokensUsd: number;
}

/**
 * Real HTTP integration against an OpenAI-compatible chat-completions
 * endpoint (the closest thing to a generic "AI provider" shape this
 * project's spec names — see .env.example's AI_PROVIDER_* comment).
 * Never called with a missing API key: `resolveAiProvider` only
 * constructs this when one is present.
 */
export class OpenAiCompatibleProvider implements AiContentProvider {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly timeoutMs: number,
    private readonly costConfig: CostConfig | null,
  ) {}

  async generateCaption(input: GenerateCaptionInput): Promise<GenerateCaptionResult> {
    const prompt = [
      "You write short social media captions with relevant hashtags.",
      `Target platform: ${input.platform ?? "general (no specific platform)"}.`,
      input.existingCaption ? `Existing caption for context: "${input.existingCaption}"` : "No existing caption.",
      'Respond with strict JSON only, no prose: {"caption": string, "hashtags": string[]}.',
    ].join("\n");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.7,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new AiProviderTimeoutError(this.timeoutMs);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    if (res.status === 429) {
      const retryAfterHeader = res.headers.get("retry-after");
      const bodyText = await res.text().catch(() => "");
      throw new AiProviderRateLimitError(
        `AI provider rate-limited this request (429). ${bodyText}`.trim(),
        retryAfterHeader ? Number(retryAfterHeader) : undefined,
      );
    }
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw new Error(`AI provider request failed: ${res.status} ${res.statusText} ${bodyText}`.trim());
    }

    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("AI provider response had no message content.");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error("AI provider response was not valid JSON.");
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { caption?: unknown }).caption !== "string" ||
      !Array.isArray((parsed as { hashtags?: unknown }).hashtags)
    ) {
      throw new Error("AI provider response JSON did not match the expected {caption, hashtags} shape.");
    }
    const result = parsed as { caption: string; hashtags: unknown[] };

    const promptTokens = body.usage?.prompt_tokens ?? null;
    const completionTokens = body.usage?.completion_tokens ?? null;
    const estimatedCostUsd =
      this.costConfig && promptTokens !== null && completionTokens !== null
        ? (promptTokens / 1000) * this.costConfig.costPer1kPromptTokensUsd +
          (completionTokens / 1000) * this.costConfig.costPer1kCompletionTokensUsd
        : null;

    return {
      caption: result.caption,
      hashtags: result.hashtags.filter((h): h is string => typeof h === "string"),
      usage: body.usage
        ? {
            promptTokens,
            completionTokens,
            totalTokens: body.usage.total_tokens ?? null,
            estimatedCostUsd,
          }
        : null,
    };
  }
}

/** Returns `null` when AI_PROVIDER_API_KEY isn't set — callers must not treat that as success. */
export function resolveAiProvider(
  env: Pick<
    Env,
    | "AI_PROVIDER_API_KEY"
    | "AI_PROVIDER_BASE_URL"
    | "AI_PROVIDER_MODEL"
    | "AI_PROVIDER_TIMEOUT_MS"
    | "AI_PROVIDER_COST_PER_1K_PROMPT_TOKENS_USD"
    | "AI_PROVIDER_COST_PER_1K_COMPLETION_TOKENS_USD"
  >,
): AiContentProvider | null {
  if (!env.AI_PROVIDER_API_KEY) return null;
  const costConfig =
    env.AI_PROVIDER_COST_PER_1K_PROMPT_TOKENS_USD !== undefined &&
    env.AI_PROVIDER_COST_PER_1K_COMPLETION_TOKENS_USD !== undefined
      ? {
          costPer1kPromptTokensUsd: env.AI_PROVIDER_COST_PER_1K_PROMPT_TOKENS_USD,
          costPer1kCompletionTokensUsd: env.AI_PROVIDER_COST_PER_1K_COMPLETION_TOKENS_USD,
        }
      : null;
  return new OpenAiCompatibleProvider(
    env.AI_PROVIDER_API_KEY,
    env.AI_PROVIDER_BASE_URL,
    env.AI_PROVIDER_MODEL,
    env.AI_PROVIDER_TIMEOUT_MS,
    costConfig,
  );
}
