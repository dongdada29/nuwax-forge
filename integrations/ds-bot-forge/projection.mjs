import { createHash } from 'node:crypto';

const integer = value => Number.isSafeInteger(value) && value >= 0;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const nonempty = value => typeof value === 'string' && value.length > 0;
const sourceHash = usage => createHash('sha256').update(JSON.stringify(usage)).digest('hex');

// This validates the existing Forge result's cross-file evidence. It does not
// estimate, settle or write budgets and never promotes a lone success flag.
export function projectBudget({ manifest, request, guard, settlement, usage }) {
  const reconciliation = settlement?.reconciliation;
  const input = usage?.usage?.inputTokens, output = usage?.usage?.outputTokens;
  const total = integer(input) && integer(output) && integer(input + output) ? input + output : null;
  const observation = usage?.observation;
  const identified = nonempty(observation?.sessionId) && Array.isArray(observation?.errors) && observation.errors.length === 0;
  const maxTokens = request?.budget?.maxTokens;
  const observed = raw => {
    if (!raw || !integer(maxTokens) || maxTokens < 1 || raw.maxTokens !== maxTokens) return null;
    const bound = raw.reportedTokensLowerBound;
    if (bound !== null && !integer(bound)) return null;
    const verdict = bound !== null && bound > maxTokens ? 'exceeds' : 'unknown';
    if (raw.verdict !== verdict) return null;
    // When the original usage file is available, its reported lower bound,
    // identity and token parts must agree with the projected observation.
    if (usage && (observation?.reportedTokensLowerBound !== bound
      || bound !== null && (!identified || total !== bound || usage.inputSemantics !== 'includes-cache'))) return null;
    return { maxTokens, reportedTokensLowerBound: bound, verdict };
  };
  const storedObserved = observed(settlement?.observedBudget);
  const manifestObserved = observed(manifest?.observedBudget);
  let observedValue = null, observedSource = null, conflict = false;
  if (settlement) {
    if (storedObserved && (!manifest?.observedBudget || manifestObserved && same(storedObserved, manifestObserved))) {
      observedValue = storedObserved; observedSource = 'settlement';
    } else if (settlement.observedBudget || manifest?.observedBudget) conflict = true;
  } else if (manifestObserved) { observedValue = manifestObserved; observedSource = 'manifest'; }
  else if (manifest?.observedBudget) conflict = true;

  const actual = reconciliation?.actual;
  const rawUsage = usage?.usage;
  const fullUsage = manifest?.usageKnown === true && manifest.processPassed === true && manifest.modelDispatched === true
    && manifest.agentCompleted === true && identified && observation.known === true && observation.agentCompleted === true
    && usage.usageScope === 'run-segment' && usage.inputSemantics === 'includes-cache' && total !== null
    && observation.reportedTokensLowerBound === total
    && (rawUsage.cachedReadTokens === null || integer(rawUsage.cachedReadTokens) && rawUsage.cachedReadTokens <= input)
    && (rawUsage.cacheWriteTokens === null || integer(rawUsage.cacheWriteTokens));
  const estimate = guard?.estimate;
  const cap = estimate?.budget?.budgetTokens;
  const sample = reconciliation?.sample;
  const dimensions = reconciliation?.comparison?.dimensions;
  const dimensionMatches = (name, value) => Array.isArray(dimensions)
    && dimensions.filter(row => row.dimension === name).length === 1
    && dimensions.find(row => row.dimension === name).actual === value;
  const amountsMatch = fullUsage && [manifest.chargedTokens, settlement?.chargedTokens].every(value => value === total)
    && actual?.inputSemantics === 'includes-cache' && actual.usageScope === 'run-segment'
    && actual.completeness?.known === true && actual.completeness?.complete === true && actual.completeness.retryObserved === false
    && ['inputTokens', 'outputTokens', 'cachedReadTokens', 'cacheWriteTokens'].every(key => actual.usage?.[key] === rawUsage[key])
    && actual.usage.comparableInputIncludingCachedRead === input
    && dimensionMatches('totalTokens', total) && dimensionMatches('inputTokens(includes-cached)', input) && dimensionMatches('outputTokens', output);
  const provenanceMatches = amountsMatch && reconciliation?.ok === true && reconciliation.kind === 'token-budget-reconcile'
    && reconciliation.schemaVersion === 1 && reconciliation.usableForCalibration === true
    && estimate?.kind === 'token-budget-estimate' && guard.allowed === true
    && ['id', 'model', 'taskKind'].every(key => same(reconciliation.estimate?.[key], estimate.spec?.[key]))
    && sample?.sourceHash === sourceHash(usage) && sample.estimateId === estimate.spec.id
    && same(sample.model, estimate.spec.model) && sample.taskKind === estimate.spec.taskKind
    && sample.calibrationEligible === true && sample.usageScope === 'run-segment' && sample.inputSemantics === 'includes-cache'
    && sample.actual?.inputTokens === input && sample.actual.outputTokens === output
    && sample.actual.cachedReadTokens === rawUsage.cachedReadTokens;
  const verdict = reconciliation?.budget?.verdict;
  const verdictMatches = provenanceMatches && integer(cap) && cap > 0 && cap === request?.budgetSpec?.budgetTokens
    && reconciliation.budget.budgetTokens === cap
    && (verdict === 'within' && total <= cap && reconciliation.budget.headroomTokens === cap - total
      || verdict === 'exceeds' && total > cap && reconciliation.budget.overByTokens === total - cap);
  const verified = verdictMatches && observedValue?.reportedTokensLowerBound === total && !conflict;
  const declaredKnown = typeof manifest?.usageKnown === 'boolean' ? manifest.usageKnown : null;
  if (declaredKnown === true && !verified || declaredKnown === false && observation?.known === true) conflict = true;
  return {
    usageKnown: verified ? true : declaredKnown === false && observation?.known !== true ? false : null,
    chargedTokens: verified ? total : null,
    verdict: verified ? verdict : 'unknown',
    observedVerdict: observedValue?.verdict ?? 'unknown',
    reportedTokensLowerBound: observedValue?.reportedTokensLowerBound ?? null,
    observedSource,
    consistency: conflict ? 'conflict' : verified ? 'verified' : 'unknown',
  };
}
