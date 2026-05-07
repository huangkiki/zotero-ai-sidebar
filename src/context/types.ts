// MessageContext schema for context-card display + ledger formatting.
// Each `planMode` value below maps to one tool/UI path:
//   none / metadata_only / annotations / search_pdf / pdf_range /
//   selected_text / full_pdf / remote_paper / reader_pdf_text /
//   annotation_write / previous_context.
// INVARIANT: this is descriptive metadata captured AFTER the model picks
// a tool — not a planner schema. The model's choice is the planner.
export type ContextMode =
  | "none"
  | "metadata_only"
  | "annotations"
  | "search_pdf"
  | "pdf_range"
  | "selected_text"
  | "full_pdf"
  | "remote_paper"
  | "reader_pdf_text"
  | "annotation_write"
  | "note_write"
  | "previous_context";

export type ContextPlanSource = "selected" | "model" | "fallback";
export type ContextSelectionSource = "model" | "fallback";
export type ContextSourceKind = "zotero_item" | "arxiv";

export interface ToolTrace {
  name: string;
  status: "started" | "completed" | "error";
  summary?: string;
}

export interface RetrievedPassage {
  text: string;
  score: number;
  start: number;
  end: number;
}

export interface ItemAnnotation {
  type: string;
  text: string;
  comment?: string;
  pageLabel?: string;
  color?: string;
  sortIndex?: number;
}

export interface MessageContext {
  sourceKind?: ContextSourceKind;
  sourceID?: string;
  sourceTitle?: string;
  sourceUrl?: string;
  selectedText?: string;
  explainSelection?: boolean;
  annotationSuggestion?: boolean;
  annotationColorGuide?: string;
  // Captured at the moment the user message was submitted (whether the
  // task ran immediately or was queued for later). Lets a queued task that
  // runs later still anchor its "建议注释" card to the original PDF
  // selection — without this, the live selection at the time the queued
  // task fires would be used (or none), breaking the contract that the
  // selection follows the message that was typed against it.
  queuedAnnotationSnapshot?: {
    text: string;
    attachmentID: number;
    annotation: Record<string, unknown>;
  };
  queuedAnnotationColorEnabled?: boolean;
  planMode?: ContextMode;
  planReason?: string;
  plannerSource?: ContextPlanSource;
  query?: string;
  rangeStart?: number;
  rangeEnd?: number;
  annotations?: ItemAnnotation[];
  candidatePassageCount?: number;
  selectedPassageNumbers?: number[];
  passageSelectionReason?: string;
  passageSelectorSource?: ContextSelectionSource;
  retrievedPassages?: RetrievedPassage[];
  fullTextChars?: number;
  fullTextTotalChars?: number;
  fullTextTruncated?: boolean;
  retainedContextCount?: number;
  retainedContextChars?: number;
  toolCalls?: ToolTrace[];
}
