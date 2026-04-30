export type ContextMode =
  | 'none'
  | 'metadata_only'
  | 'annotations'
  | 'search_pdf'
  | 'pdf_range'
  | 'selected_text'
  | 'full_pdf';

export type ContextPlanSource = 'selected' | 'model' | 'fallback';
export type ContextSelectionSource = 'model' | 'fallback';

export interface ToolTrace {
  name: string;
  status: 'started' | 'completed' | 'error';
  summary?: string;
}

export interface ContextPlan {
  mode: ContextMode;
  query?: string;
  topK?: number;
  rangeStart?: number;
  rangeEnd?: number;
  reason?: string;
  source?: ContextPlanSource;
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
  selectedText?: string;
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
  retainedContextCount?: number;
  retainedContextChars?: number;
  toolCalls?: ToolTrace[];
}
