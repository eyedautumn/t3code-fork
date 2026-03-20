/**
 * OpencodeAdapter - Opencode implementation of the generic provider adapter contract.
 *
 * This service owns Opencode server / HTTP API semantics and emits
 * Opencode provider events. It does not perform cross-provider routing, shared
 * event fan-out, or checkpoint orchestration.
 *
 * Uses Effect `ServiceMap.Service` for dependency injection and returns the
 * shared provider-adapter error channel with provider: "opencode" context.
 *
 * @module OpencodeAdapter
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * OpencodeAdapterShape - Service API for the Opencode provider adapter.
 */
export interface OpencodeAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "opencode";
}

/**
 * OpencodeAdapter - Service tag for Opencode provider adapter operations.
 */
export class OpencodeAdapter extends ServiceMap.Service<OpencodeAdapter, OpencodeAdapterShape>()(
  "t3/provider/Services/OpencodeAdapter",
) {}