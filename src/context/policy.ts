export interface ContextPolicy {
  fullPdfTokenBudget: number;
  searchContextTokenBudget: number;
  searchCandidateCount: number;
  maxSelectedTextChars: number;
  maxPassageChars: number;
  passageOverlapChars: number;
  maxRangeChars: number;
  maxAnnotations: number;
  retainedContextTurnCount: number;
  retainedContextCharBudget: number;
  maxSearchTopK: number;
  maxSelectedPassages: number;
  fullTextCacheReadCharLimit: number;
  maxToolIterations: number;
  maxAnnotationCommentChars: number;
}

export const DEFAULT_CONTEXT_POLICY: ContextPolicy = {
  fullPdfTokenBudget: 60_000,
  searchContextTokenBudget: 100_000,
  searchCandidateCount: 8,
  maxSelectedTextChars: 20_000,
  maxPassageChars: 1200,
  passageOverlapChars: 160,
  maxRangeChars: 9000,
  maxAnnotations: 80,
  retainedContextTurnCount: 4,
  retainedContextCharBudget: 8000,
  maxSearchTopK: 8,
  maxSelectedPassages: 3,
  fullTextCacheReadCharLimit: 400_000,
  maxToolIterations: 100,
  maxAnnotationCommentChars: 4000,
};
