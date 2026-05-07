import type { Message } from "../providers/types";
import { DEFAULT_CONTEXT_POLICY, type ContextPolicy } from "./policy";
import type { ItemAnnotation, RetrievedPassage } from "./types";

// Prompt assembly + context ledger.
//
// Two distinct shapes flow through this file:
// - Wire shape (`toApiMessages`): what the provider actually sees. The
//   *current* user turn gets context blocks inlined; older turns either
//   replay a small slice (selected text / annotations / passages) or
//   collapse to plain content.
// - Display shape (`formatContextMarkdown`, `contextSummaryLine`): what
//   the sidebar renders so the user can audit *what was sent*.
//
// INVARIANT: full PDF text from past turns is NEVER replayed. It lives in
// the message's `context` metadata only; replays surface as "已发送 PDF
// 全文 N 字" in the ledger. (See CLAUDE.md "context ledger design".)
//
// REF: Codex-style context compaction; Claudian's per-message context card.

export function toApiMessages(
  messages: Message[],
  currentContext?: { message: Message; fullText?: string },
  policy: ContextPolicy = DEFAULT_CONTEXT_POLICY,
): Message[] {
  const currentIndex = currentContext
    ? messages.indexOf(currentContext.message)
    : messages.length - 1;
  const retainedContextIndexes = retainedRecentContextIndexes(
    messages,
    currentIndex,
    policy,
  );

  return messages.map((message) => ({
    role: message.role,
    content:
      message.role === "user" &&
      (currentContext?.message === message ||
        retainedContextIndexes.has(messages.indexOf(message)))
        ? formatUserMessageForApi(
            message,
            currentContext?.message === message
              ? currentContext.fullText
              : undefined,
            {
              includeTurnInstructions: currentContext?.message === message,
            },
          )
        : message.content,
    ...(message.images?.length ? { images: message.images } : {}),
  }));
}

export function retainedContextStats(
  messages: Message[],
  currentMessage: Message,
  policy: ContextPolicy = DEFAULT_CONTEXT_POLICY,
): { count: number; chars: number } {
  const currentIndex = messages.indexOf(currentMessage);
  if (currentIndex < 0) return { count: 0, chars: 0 };
  const indexes = retainedRecentContextIndexes(messages, currentIndex, policy);
  let chars = 0;
  indexes.forEach((index) => {
    chars += contextSourceChars(messages[index]);
  });
  return { count: indexes.size, chars };
}

export function formatUserMessageForApi(
  message: Message,
  fullText?: string,
  options: { includeTurnInstructions?: boolean } = {
    includeTurnInstructions: true,
  },
): string {
  const contextBlocks = formatContextBlocks(
    message,
    fullText,
    options.includeTurnInstructions !== false,
  );
  if (!contextBlocks.length) return message.content;
  return [...contextBlocks, "[User question]", message.content].join("\n");
}

export function formatRetrievedPassages(passages: RetrievedPassage[]): string {
  return passages
    .map(
      (passage, index) =>
        `[${index + 1}] chars ${passage.start}-${passage.end}, score ${passage.score}\n${passage.text}`,
    )
    .join("\n\n");
}

export function contextSummaryLine(message: Message): string {
  const context = message.context;
  if (!context) return "";
  if (context.selectedText) {
    const passageChars =
      context.retrievedPassages?.reduce(
        (sum, passage) => sum + passage.text.length,
        0,
      ) ?? 0;
    return [
      `已随本轮发送 PDF 选区 ${context.selectedText.length} 字`,
      passageChars ? `自动附带附近上下文 ${passageChars} 字` : "",
      retainedContextSuffix(context),
    ]
      .filter(Boolean)
      .join("；");
  }
  if (context.annotations?.length) {
    return `已随本轮发送 Zotero 标注 ${context.annotations.length} 条`;
  }
  if (context.retrievedPassages?.length) {
    const chars = context.retrievedPassages.reduce(
      (sum, passage) => sum + passage.text.length,
      0,
    );
    if (context.planMode === "previous_context") {
      return `模型复用历史上下文 ${context.retrievedPassages.length} 段 / ${chars} 字`;
    }
    if (context.planMode === "pdf_range") {
      return `模型请求 PDF 字符范围 ${context.retrievedPassages.length} 段 / ${chars} 字`;
    }
    const candidateSuffix = context.candidatePassageCount
      ? `/${context.candidatePassageCount}`
      : "";
    const source =
      context.passageSelectorSource === "fallback"
        ? "本地兜底选择"
        : "模型选择";
    return `${source} PDF 片段 ${context.retrievedPassages.length}${candidateSuffix} 段 / ${chars} 字`;
  }
  if (context.candidatePassageCount) {
    return `模型查看 PDF 候选 ${context.candidatePassageCount} 段，最终未发送片段`;
  }
  if (context.fullTextChars) {
    const total = context.fullTextTotalChars;
    const suffix =
      total && total !== context.fullTextChars
        ? `/${total} 字${context.fullTextTruncated ? "（已截断）" : ""}`
        : " 字";
    if (context.planMode === "reader_pdf_text") {
      return `模型请求 Reader PDF 文本 ${context.fullTextChars}${suffix}`;
    }
    if (context.planMode === "remote_paper") {
      return `模型请求远程 arXiv 论文文本 ${context.fullTextChars}${suffix}`;
    }
    return `已随本轮发送 PDF 全文 ${context.fullTextChars}${suffix}`;
  }
  if (context.toolCalls?.length) {
    const completed = context.toolCalls.filter(
      (tool) => tool.status === "completed",
    ).length;
    const errors = context.toolCalls.filter(
      (tool) => tool.status === "error",
    ).length;
    return `模型调用 Zotero 工具 ${context.toolCalls.length} 次 / 完成 ${completed} / 错误 ${errors}`;
  }
  if (context.planMode === "metadata_only") {
    return "本轮仅发送题录/摘要信息";
  }
  if (context.planMode === "annotations") {
    return "本轮请求 Zotero 标注，但未找到可发送内容";
  }
  if (context.planMode === "none") {
    if (context.retainedContextCount) {
      return `本轮未请求新论文正文；保留最近上下文 ${context.retainedContextCount} 段 / ${context.retainedContextChars ?? 0} 字`;
    }
    return "本轮未发送论文正文";
  }
  return "";
}

function retainedContextSuffix(context: Message["context"]): string {
  if (!context?.retainedContextCount) return "";
  return `另保留最近上下文 ${context.retainedContextCount} 条 / ${context.retainedContextChars ?? 0} 字`;
}

export function formatContextMarkdown(message: Message): string[] {
  const context = message.context;
  if (!context) return [];

  const lines: string[] = [];
  const summary = contextSummaryLine(message);
  if (summary) lines.push("### 上下文", "", summary, "");
  if (context.planReason) {
    lines.push(
      `- 规划: ${context.planMode ?? "unknown"} (${context.plannerSource ?? "unknown"})`,
    );
    lines.push(`- 原因: ${context.planReason}`);
    if (context.query) lines.push(`- 检索问题: ${context.query}`);
    if (
      typeof context.rangeStart === "number" &&
      typeof context.rangeEnd === "number"
    ) {
      lines.push(`- PDF 范围: ${context.rangeStart}-${context.rangeEnd}`);
    }
    if (context.candidatePassageCount) {
      lines.push(`- 候选片段: ${context.candidatePassageCount}`);
    }
    if (context.selectedPassageNumbers?.length) {
      lines.push(`- 选中片段: ${context.selectedPassageNumbers.join(", ")}`);
    }
    if (context.passageSelectionReason) {
      lines.push(
        `- 片段选择: ${context.passageSelectorSource ?? "unknown"}; ${context.passageSelectionReason}`,
      );
    }
    lines.push("");
  }
  if (context.toolCalls?.length) {
    lines.push(`- 工具调用: ${formatToolTraceInline(context.toolCalls)}`, "");
  }
  if (context.selectedText) {
    lines.push("### PDF 选区", "", context.selectedText, "");
  }
  if (context.retrievedPassages?.length) {
    lines.push(
      "### PDF 检索片段",
      "",
      formatRetrievedPassages(context.retrievedPassages),
      "",
    );
  }
  return lines;
}

// Builds a compact, machine-friendly ledger of every prior turn's context
// (mode, ranges, char counts, tool calls). WHY: handed to the model as a
// system-prompt appendix so it can refer to "you already saw passage
// 4500-5800 in turn 3" without us re-sending the bytes. This is the
// project's substitute for Codex `previous_response_id` chaining.
export function formatContextLedger(messages: Message[]): string {
  const lines: string[] = [];
  messages.forEach((message, index) => {
    if (message.role !== "user" || !message.context) return;
    const context = message.context;
    const parts = [
      `turn ${index + 1}`,
      `mode=${context.planMode ?? "unknown"}`,
    ];
    if (context.sourceKind) parts.push(`source_kind=${context.sourceKind}`);
    if (context.sourceID) parts.push(`source_id=${JSON.stringify(context.sourceID)}`);
    if (context.sourceTitle)
      parts.push(`source_title=${JSON.stringify(context.sourceTitle)}`);
    if (context.sourceUrl) parts.push(`source_url=${JSON.stringify(context.sourceUrl)}`);
    if (context.selectedText)
      parts.push(`selected_text_chars=${context.selectedText.length}`);
    if (context.fullTextChars) {
      parts.push(
        context.planMode === "reader_pdf_text"
          ? `reader_pdf_text_chars=${context.fullTextChars}`
          : context.planMode === "remote_paper"
            ? `remote_paper_chars=${context.fullTextChars}`
            : `full_pdf_chars=${context.fullTextChars}`,
      );
    }
    if (context.fullTextTotalChars) {
      parts.push(
        context.planMode === "reader_pdf_text"
          ? `reader_pdf_text_total_chars=${context.fullTextTotalChars}`
          : context.planMode === "remote_paper"
            ? `remote_paper_total_chars=${context.fullTextTotalChars}`
            : `full_pdf_total_chars=${context.fullTextTotalChars}`,
      );
    }
    if (context.fullTextTruncated) {
      parts.push(
        context.planMode === "reader_pdf_text"
          ? "reader_pdf_text_truncated=true"
          : context.planMode === "remote_paper"
            ? "remote_paper_truncated=true"
            : "full_pdf_truncated=true",
      );
    }
    if (context.retrievedPassages?.length) {
      const chars = context.retrievedPassages.reduce(
        (sum, passage) => sum + passage.text.length,
        0,
      );
      const ranges = context.retrievedPassages
        .map((passage) => `${passage.start}-${passage.end}`)
        .join(",");
      parts.push(`pdf_passages=${context.retrievedPassages.length}`);
      parts.push(`pdf_passage_chars=${chars}`);
      parts.push(`pdf_ranges=${ranges}`);
      parts.push("previous_context_tool=chat_get_previous_context");
    }
    if (context.candidatePassageCount) {
      parts.push(`candidate_passages=${context.candidatePassageCount}`);
    }
    if (context.selectedPassageNumbers?.length) {
      parts.push(
        `selected_candidates=${context.selectedPassageNumbers.join(",")}`,
      );
    }
    if (context.query) parts.push(`query=${JSON.stringify(context.query)}`);
    if (
      typeof context.rangeStart === "number" &&
      typeof context.rangeEnd === "number"
    ) {
      parts.push(`requested_range=${context.rangeStart}-${context.rangeEnd}`);
    }
    if (context.annotations?.length)
      parts.push(`annotations=${context.annotations.length}`);
    if (context.retainedContextCount) {
      parts.push(`retained_contexts=${context.retainedContextCount}`);
      parts.push(`retained_context_chars=${context.retainedContextChars ?? 0}`);
    }
    if (context.toolCalls?.length) {
      parts.push(`tool_calls=${formatToolTraceInline(context.toolCalls)}`);
    }
    lines.push(`- ${parts.join("; ")}`);
  });
  return lines.length ? lines.join("\n") : "none";
}

function formatToolTraceInline(
  tools: Array<{ name: string; status: string; summary?: string }>,
): string {
  return tools
    .map(
      (tool) =>
        `${tool.name}:${tool.status}${tool.summary ? ` (${tool.summary})` : ""}`,
    )
    .join("; ");
}

function formatContextBlocks(
  message: Message,
  fullText?: string,
  includeTurnInstructions = true,
): string[] {
  const context = message.context;
  if (!context && !fullText) return [];

  const blocks: string[] = [];
  if (context?.selectedText) {
    blocks.push("[Selected PDF text]", context.selectedText, "");
    if (includeTurnInstructions) {
      blocks.push(
        "[Selected text handling instruction]",
        selectedTextHandlingInstruction(),
        "",
      );
    }
  }
  if (context?.annotations?.length) {
    blocks.push(
      "[Zotero annotations]",
      formatAnnotations(context.annotations),
      "",
    );
  }
  if (context?.retrievedPassages?.length) {
    blocks.push(
      "[Retrieved PDF passages]",
      formatRetrievedPassages(context.retrievedPassages),
      "",
    );
  }
  if (fullText) {
    blocks.push("[Paper full text]", fullText, "");
  }
  if (includeTurnInstructions && context?.annotationSuggestion) {
    blocks.push(
      "[Annotation suggestion instruction]",
      annotationSuggestionInstruction(context),
      "",
    );
  }
  if (context?.planMode && !context.selectedText) {
    blocks.push(
      "[Context plan]",
      [
        `mode: ${context.planMode}`,
        context.plannerSource ? `source: ${context.plannerSource}` : "",
        context.planReason ? `reason: ${context.planReason}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      "",
    );
  }
  return blocks;
}

function selectedTextHandlingInstruction(): string {
  return [
    "用户问题若要求翻译、改写、润色、提取或逐句处理当前 PDF 选区，必须处理完整选区文本。",
    "这类任务只处理 [Selected PDF text]；不要把 [Retrieved PDF passages]、附近上下文或历史选区混入译文/改写结果。",
    "尽量保留 [Selected PDF text] 中的段落、编号列表和项目结构；不要保留 PDF 版面造成的机械换行。",
    "除非用户明确要求总结/压缩，不要用省略号（如 …、……、...）替代选区中的未翻译或未处理内容。",
    "如果选区本身包含省略号，可以保留原文含义，但不要新增省略来跳过内容。",
  ].join("\n");
}

function annotationSuggestionInstruction(
  context: NonNullable<Message["context"]>,
): string {
  const lines = [
    context.explainSelection
      ? "本轮是解释选区。回答末尾必须另起一段，以 `建议注释：` 开头，用 `- ` 列出 1-3 条可直接保存到 PDF 的简短注释要点（每条 <= 80 字）。"
      : "本轮用户是在 PDF 选区基础上手动提问。请先正常回答用户问题；回答结束后，另起一段，以 `建议注释：` 开头，用 `- ` 列出 1-3 条可直接保存到 PDF 的简短注释要点（每条 <= 80 字）。",
    "建议注释只能写当前选区和已核对上下文支持的内容；证据不足时明确写“基于当前上下文尚不能确定”。",
  ];
  if (context.annotationColorGuide) {
    lines.push(
      "请参考 PDF 注释颜色预设，为本次选区选择一个最匹配的预设颜色；类别不明确时省略颜色，不要强行分类。",
      `当前颜色预设：\n${context.annotationColorGuide}`,
      "如果选择了颜色，请在 `建议注释：` 段最后另起一行输出 `建议颜色：#hex`；只能使用预设中已有的 hex。",
    );
  }
  return lines.join("\n");
}

export function formatAnnotations(annotations: ItemAnnotation[]): string {
  return annotations
    .map((annotation, index) => {
      const parts = [
        `[${index + 1}] ${annotation.type}`,
        annotation.pageLabel ? `page ${annotation.pageLabel}` : "",
        annotation.color ? annotation.color : "",
      ].filter(Boolean);
      const body = [
        parts.join(" · "),
        annotation.text,
        annotation.comment ? `Comment: ${annotation.comment}` : "",
      ].filter(Boolean);
      return body.join("\n");
    })
    .join("\n\n");
}

// Picks which prior user turns are eligible to have their context blocks
// re-inlined into the wire shape. Three guards run in order, all required:
//
// 1. Turn window: only look at the last `retainedContextTurnCount` user
//    turns. Older context falls off into "ledger only" status.
// 2. Char budget: each retained turn deducts from a shared char budget;
//    once it's exhausted, no more replays this turn.
// 3. Signature dedup: if turn N and turn N-2 both carry the SAME selected
//    text / passage range, replay only the more recent one. WHY: avoids
//    sending the same paragraph 3× when the user keeps re-asking about it,
//    and avoids cache-busting Anthropic's ephemeral cache.
function retainedRecentContextIndexes(
  messages: Message[],
  currentIndex: number,
  policy: ContextPolicy,
): Set<number> {
  const retained = new Set<number>();
  if (messages[currentIndex]?.context?.selectedText) return retained;

  const signatures = new Set<string>();
  let remainingChars = policy.retainedContextCharBudget;
  const minIndex = Math.max(0, currentIndex - policy.retainedContextTurnCount);

  for (let index = currentIndex - 1; index >= minIndex; index--) {
    const message = messages[index];
    if (message?.role !== "user" || !message.context) continue;
    const chars = contextSourceChars(message);
    if (chars <= 0 || chars > remainingChars) continue;
    const signature = contextSignature(message);
    if (signature && signatures.has(signature)) continue;
    retained.add(index);
    if (signature) signatures.add(signature);
    remainingChars -= chars;
  }
  return retained;
}

function contextSourceChars(message: Message): number {
  const context = message.context;
  if (!context) return 0;
  const annotationChars =
    context.annotations?.reduce(
      (sum, annotation) =>
        sum + annotation.text.length + (annotation.comment?.length ?? 0),
      0,
    ) ?? 0;
  const passageChars =
    context.retrievedPassages?.reduce(
      (sum, passage) => sum + passage.text.length,
      0,
    ) ?? 0;
  return (context.selectedText?.length ?? 0) + annotationChars + passageChars;
}

function contextSignature(message: Message): string {
  const context = message.context;
  if (!context) return "";
  if (context.selectedText) return `selected:${context.selectedText}`;
  if (context.retrievedPassages?.length) {
    return `passages:${context.retrievedPassages
      .map((passage) => `${passage.start}-${passage.end}`)
      .join(",")}`;
  }
  if (context.annotations?.length) {
    return `annotations:${context.annotations
      .map((annotation) => `${annotation.pageLabel ?? ""}:${annotation.text}`)
      .join("|")}`;
  }
  return "";
}
