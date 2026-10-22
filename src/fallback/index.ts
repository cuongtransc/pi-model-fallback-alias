export type {
	AliasConfig,
	AliasExpansionWarning,
	AliasMap,
	AliasPolicy,
	AliasPolicyInput,
	AliasSettingWarning,
	AttemptLatencyOutcome,
	AttemptLatencySample,
	AttemptTimeouts,
	CooldownPolicy,
	CooldownRegistry,
	CooldownState,
	CooldownUpdate,
	FailoverEntryData,
	FallbackOptions,
	ResolvedTarget,
	TargetFailure,
	TargetRegistry,
	TimerApi,
	TimerHandle,
} from "./types.ts";

export {
	ACCOUNT_COOLDOWN_POLICY,
	BUILT_IN_COOLDOWN_POLICY,
	COOLDOWN_BASE_MS,
	COOLDOWN_CAP_MS,
	classifyFailure,
	createCooldownRegistry,
	DEFAULT_STATUS_REFRESH_MS,
	type FailureClass,
	isQuotaExhausted,
	MAX_STATUS_REFRESH_MS,
	nextCooldown,
	providerCooldownKey,
	QUOTA_COOLDOWN_POLICY,
	runQuotaResetCommand,
} from "./cooldown.ts";

export { BUILT_IN_POLICY, parseAliasConfig } from "./config.ts";

export {
	describeFailure,
	failureStopReason,
	formatExhaustionError,
	resolveFirstTarget,
	resolveTargetReference,
} from "./refs.ts";

export { DEFAULT_TIMERS, runFallbackChain } from "./chain.ts";
