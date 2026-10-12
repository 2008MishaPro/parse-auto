import { createHash } from 'node:crypto';
import type { Outcome } from './contracts.ts';

export interface SourceState {
  failureCount: number;
  blockedUntil: string | null;
  lastAttempt: string | null;
  lastSuccess: string | null;
  lastOutcome: Outcome | null;
  legacyEstimate?: boolean;
}

export interface GapInput {
  runId: string;
  since: string | null;
  until: string;
  reason: string;
}

export interface CoverageGap extends GapInput {
  gapId: string;
  searchId: string;
  sequence: number;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const nullableTimestamp = (value: unknown) => value === null || timestamp(value);
const outcomes = new Set(['success', 'empty', 'partial', 'blocked', 'auth_required', 'rate_limited', 'schema_changed', 'transport_error', 'timeout']);

export const emptySource = (): SourceState => ({ failureCount: 0, blockedUntil: null, lastAttempt: null, lastSuccess: null, lastOutcome: null });

export function assertSourceState(value: unknown): asserts value is SourceState {
  if (!object(value) || !Number.isSafeInteger(value.failureCount) || (value.failureCount as number) < 0
    || !nullableTimestamp(value.blockedUntil) || !nullableTimestamp(value.lastAttempt) || !nullableTimestamp(value.lastSuccess)
    || !(value.lastOutcome === null || typeof value.lastOutcome === 'string' && outcomes.has(value.lastOutcome))
    || Object.hasOwn(value, 'legacyEstimate') && typeof value.legacyEstimate !== 'boolean'
    || Object.keys(value).some(key => !['failureCount', 'blockedUntil', 'lastAttempt', 'lastSuccess', 'lastOutcome', 'legacyEstimate'].includes(key))) {
    throw new Error('Некорректное состояние источника');
  }
  if ((value.lastOutcome === 'success' || value.lastOutcome === 'empty') && (value.failureCount !== 0 || value.blockedUntil !== null)) {
    throw new Error('Успешный источник сохраняет ошибочный backoff');
  }
}

export function assertGapInput(value: unknown): asserts value is GapInput {
  if (!object(value) || typeof value.runId !== 'string' || !value.runId || !nullableTimestamp(value.since)
    || !timestamp(value.until) || value.since !== null && timestamp(value.since) && Date.parse(value.since) > Date.parse(value.until)
    || typeof value.reason !== 'string' || !value.reason
    || Object.keys(value).some(key => !['runId', 'since', 'until', 'reason'].includes(key))) throw new Error('Некорректный период возможных пропусков');
}

export const gapIdentity = (searchId: string, runId: string, reason: string) =>
  createHash('sha256').update(JSON.stringify([searchId, runId, reason])).digest('hex');

export function assertGap(value: unknown, sequence: number): asserts value is CoverageGap {
  if (!object(value) || typeof value.searchId !== 'string' || !value.searchId
    || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1 || (value.sequence as number) > sequence
    || typeof value.gapId !== 'string' || value.gapId !== gapIdentity(value.searchId, String(value.runId), String(value.reason))
    || Object.keys(value).some(key => !['runId', 'since', 'until', 'reason', 'gapId', 'searchId', 'sequence'].includes(key))) {
    throw new Error('Некорректная запись истории пропусков');
  }
  assertGapInput({ runId: value.runId, since: value.since, until: value.until, reason: value.reason });
}
