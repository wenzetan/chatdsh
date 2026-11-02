/**
 * 引用模块的出口。
 * @module @chatdsh/client-conversation/references
 */

export {
  REFERENCE_INVALID_REASONS,
  REFERENCE_INVALID_TEXT,
  REFERENCE_KIND_TEXT,
  REFERENCE_OBJECT_KINDS,
  describeReference,
  intersectsSpan,
  isPersistableKind,
  referenceToken,
  restoreReferences,
  shiftSpans,
  toDraftReferences,
  validateReferences,
  type PersistReferencesResult,
  type PersistedReference,
  type ReferenceCandidate,
  type ReferenceInvalidReason,
  type ReferenceObject,
  type ReferenceObjectKind,
} from './references.ts';
export { ReferenceStrip, type ReferenceStripProps } from './view.tsx';
