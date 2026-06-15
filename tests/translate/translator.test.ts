import { describe, expect, it, vi } from "vitest";
import {
  cleanTranslationOutput,
  deterministicMetadataTranslation,
  translateSentence,
  translationNeedsRetry,
} from "../../src/translate/translator";
import type { ModelPreset } from "../../src/settings/types";

vi.mock("../../src/providers/openai", () => ({
  OpenAIProvider: class {
    async *stream() {
      yield { type: "text_delta", text: "OpenAI 路径译文" };
      yield { type: "usage", input: 1, output: 1 };
    }
  },
}));

vi.mock("../../src/providers/factory", () => ({
  getProvider: (preset: ModelPreset) => ({
    async *stream() {
      yield {
        type: "text_delta",
        text:
          preset.provider === "anthropic"
            ? "Anthropic 路径译文"
            : "OpenAI 路径译文",
      };
      yield { type: "usage", input: 1, output: 1 };
    },
  }),
}));

describe("translation retry guard", () => {
  it("streams through the configured preset provider for Anthropic presets", async () => {
    const chunks: string[] = [];
    for await (const chunk of translateSentence({
      sentence: "We describe a new model.",
      preset: {
        id: "deepseek",
        label: "DeepSeek",
        provider: "anthropic",
        apiKey: "sk-test",
        baseUrl: "https://api.deepseek.com/anthropic",
        model: "deepseek-v4-pro",
        maxTokens: 8192,
      },
      model: "deepseek-v4-pro",
      thinking: "low",
      signal: new AbortController().signal,
    })) {
      if (chunk.type === "text" && chunk.text) chunks.push(chunk.text);
    }

    expect(chunks.join("")).toBe("Anthropic 路径译文");
  });

  it("retries English paraphrases for English source sentences", () => {
    expect(
      translationNeedsRetry(
        "We describe a new model based on heterogeneous tasks.",
        "This is a new model based on heterogeneous tasks.",
      ),
    ).toBe(true);
  });

  it("accepts Simplified Chinese translations with retained terms", () => {
    expect(
      translationNeedsRetry(
        "We describe π0.5, a new model based on π0.",
        "我们介绍 π0.5，这是一个基于 π0 的新模型。",
      ),
    ).toBe(false);
  });

  it("accepts compact arXiv metadata that has no translatable sentence body", () => {
    expect(
      translationNeedsRetry(
        "arXiv:2603.19312v1 [cs.LG] 13 Mar 2026",
        "arXiv:2603.19312v1 [cs.LG] 13 Mar 2026",
      ),
    ).toBe(false);
  });

  it("keeps guarding ordinary English titles that are repeated unchanged", () => {
    expect(
      translationNeedsRetry(
        "LeWorldModel: Stable End-to-End Joint-Embedding Predictive Architecture from Pixels",
        "LeWorldModel: Stable End-to-End Joint-Embedding Predictive Architecture from Pixels",
      ),
    ).toBe(true);
  });

  it("normalizes arXiv metadata dates without calling the model", () => {
    expect(
      deterministicMetadataTranslation(
        "arXiv:2603.19312v1 [cs.LG] 13 Mar 2026",
      ),
    ).toBe("arXiv:2603.19312v1 [cs.LG] 2026年3月13日");
    expect(
      deterministicMetadataTranslation(
        "arXiv:2603.19312v1 [cs.LG] 2026年3月13日",
      ),
    ).toBe("arXiv:2603.19312v1 [cs.LG] 2026年3月13日");
  });

  it("removes common translation labels from model output", () => {
    expect(cleanTranslationOutput("译文：你好")).toBe("你好");
    expect(cleanTranslationOutput("Translation: 你好")).toBe("你好");
  });
});
