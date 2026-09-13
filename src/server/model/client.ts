import { GoogleGenAI } from "@google/genai";

// One audited path to the model. Callers own call budgets and must persist the
// call count before dispatch (ModelBudget), so a crash after dispatch can never
// grant extra calls.

export type ModelPart = { text: string } | { inlineData: { mimeType: string; data: string } };
export type ModelTurn = { role: "user" | "model"; parts: ModelPart[] };

export type ModelRequest = {
  model: string;
  system: string;
  turns: ModelTurn[];
  /** JSON Schema constraining generation. Zod validation of the result is still mandatory. */
  responseJsonSchema: Record<string, unknown>;
  signal?: AbortSignal;
};

export type ModelResponse = { text: string; modelId: string };

export interface ModelClient {
  generateJson(request: ModelRequest): Promise<ModelResponse>;
}

export type ModelCallErrorKind = "timeout" | "aborted" | "provider" | "empty_response" | "budget_exhausted";

export class ModelCallError extends Error {
  constructor(
    public readonly kind: ModelCallErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "ModelCallError";
  }
}

export type ModelSelection = { primary: string; fallback: string | null };

export class GeminiModelClient implements ModelClient {
  private readonly ai: GoogleGenAI;

  constructor(apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async generateJson(request: ModelRequest): Promise<ModelResponse> {
    let response;
    try {
      response = await this.ai.models.generateContent({
        model: request.model,
        contents: request.turns,
        config: {
          systemInstruction: request.system,
          responseMimeType: "application/json",
          responseJsonSchema: request.responseJsonSchema,
          temperature: 0,
          ...(request.signal ? { abortSignal: request.signal } : {}),
        },
      });
    } catch (error) {
      if (request.signal?.aborted) throw new ModelCallError("aborted", "model call aborted");
      // Provider messages can echo request metadata; keep only the class and status.
      const status = (error as { status?: unknown }).status;
      throw new ModelCallError("provider", `model provider error${typeof status === "number" ? ` (HTTP ${status})` : ""}`);
    }
    const text = response.text;
    if (!text) throw new ModelCallError("empty_response", "model returned no text");
    return { text, modelId: request.model };
  }
}

/**
 * Counts model calls against a fixed budget. `beforeCall` persists the new
 * count before the request is dispatched; each call gets a hard timeout.
 */
export class ModelBudget {
  private used: number;

  constructor(
    private readonly limit: number,
    alreadyUsed: number,
    private readonly beforeCall: (callsIncludingThis: number) => void | Promise<void>,
    private readonly timeoutMs: number,
  ) {
    this.used = alreadyUsed;
  }

  get calls(): number {
    return this.used;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.used);
  }

  async call(client: ModelClient, request: Omit<ModelRequest, "signal">, signal?: AbortSignal): Promise<ModelResponse> {
    if (this.remaining === 0) throw new ModelCallError("budget_exhausted", `model call budget of ${this.limit} exhausted`);
    this.used += 1;
    await this.beforeCall(this.used);
    return callWithTimeout(client, request, this.timeoutMs, signal);
  }
}

export async function callWithTimeout(
  client: ModelClient,
  request: Omit<ModelRequest, "signal">,
  timeoutMs: number,
  outer?: AbortSignal,
): Promise<ModelResponse> {
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  outer?.addEventListener("abort", onOuterAbort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ModelCallError("timeout", `model call exceeded ${timeoutMs}ms`));
    }, timeoutMs);
  });
  let onAbortReject: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbortReject = () => reject(new ModelCallError("aborted", "model call aborted"));
    if (outer?.aborted) onAbortReject();
    else outer?.addEventListener("abort", onAbortReject, { once: true });
  });
  const call = client.generateJson({ ...request, signal: controller.signal });
  // Losers of the race must never surface as unhandled rejections.
  for (const pending of [call, timeout, aborted]) pending.catch(() => undefined);
  try {
    return await Promise.race([call, timeout, aborted]);
  } catch (error) {
    // Keep the model boundary uniform even for injected clients. Persistence
    // failures from ModelBudget.beforeCall happen before this function and are
    // intentionally not converted into provider retries.
    if (error instanceof ModelCallError) throw error;
    throw new ModelCallError("provider", `model provider error: ${error instanceof Error ? error.message : "unknown failure"}`);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuterAbort);
    if (onAbortReject) outer?.removeEventListener("abort", onAbortReject);
  }
}
