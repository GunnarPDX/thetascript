export interface Bar {
  date: number; // ms since epoch
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface RunOpts {
  inputs?: Record<string, unknown>;
  timezone?: string; // IANA zone, or 'local' for the host zone
  session?: { open?: string; close?: string };
}

export type InitInput =
  | RequestInfo
  | URL
  | Response
  | BufferSource
  | WebAssembly.Module;

/** Load and compile the wasm engine. Call once before runScript. */
export function init(input?: InitInput): Promise<void>;

/** Synchronous init from bytes or a compiled module (Node, inlined setups). */
export function initSync(input: BufferSource | WebAssembly.Module): void;

/**
 * Run a script over a bar tape. Throws if init() hasn't completed.
 * The result is in the conformance wire encoding (NaN -> null,
 * ±Infinity -> "Infinity"/"-Infinity", -0 -> 0).
 */
export function runScript(source: string, bars: Bar[], opts?: RunOpts | null): any;

export const LANG_VERSION: string;
export const DRAW_FN_NAMES: string[];
export const KEYWORD_NAMES: string[];
