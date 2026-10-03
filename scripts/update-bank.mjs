import { Command } from 'commander';
import { loadGatewayBankConfig, planGatewayBankUpdate, providerLabel, readIncrementalBase, updateGatewayBank } from '../build/maintainer.js';

const command = new Command()
  .name('update-bank')
  .description('Collect reference probes through Cloudflare AI Gateway or OpenRouter and atomically refresh a fingerprint bank')
  .option('--config <path>', 'JSON configuration file', process.env.LOGITPING_BANK_CONFIG || 'config/bank-update.json')
  .option('--output <path>', 'bank JSON destination', 'src/data/default_bank.json')
  .option('--restart', 'discard saved collection progress and start a new request budget')
  .option('--incremental', 'collect only configured models the output bank does not already enroll, then merge them into it')
  .option('--dry-run', 'validate configuration and report request budgets without contacting Cloudflare or OpenRouter');

function describePlan(plan, config, incremental) {
  if (incremental) {
    const list = (ids) => ids.join(', ');
    const added = plan.collect.map((model) => model.id).filter((id) => !plan.replace.includes(id));
    if (plan.retain.length) console.log(`Retaining enrolled models (${plan.retain.length}): ${list(plan.retain)}.`);
    if (plan.providerChanged.length) console.log(`Retained models enrolled through another provider (${plan.providerChanged.length}): ${list(plan.providerChanged)}; run a full update to re-collect them through the configured provider.`);
    if (added.length) console.log(`Collecting new models (${added.length}): ${list(added)}.`);
    if (plan.replace.length) console.log(`Re-collecting models that are uncalibrated or were enrolled with other settings (${plan.replace.length}): ${list(plan.replace)}.`);
    if (plan.remove.length) console.log(`Removing models no longer in the configuration (${plan.remove.length}): ${list(plan.remove)}.`);
    if (!plan.collect.length) {
      console.log(plan.remove.length ? 'No requests needed.' : 'Nothing to collect or remove: the bank already enrolls every configured model.');
      return;
    }
  }
  console.log(`${incremental ? 'Incremental' : 'Full'} collection plan: ${plan.collect.length} models via ${providerLabel(plan.collect.map((target) => target.provider))}; ${plan.requiredRuns} required runs; up to ${plan.spareRequests} additional attempts across retries/resumes; ${config.protocol.targetSamples} integers per run; requested output budget upper bound ${plan.maxOutputTokens} tokens.`);
}

const controller = new AbortController();
const abort = () => controller.abort(new Error('Bank update interrupted'));
process.once('SIGINT', abort);
process.once('SIGTERM', abort);
try {
  command.parse();
  const options = command.opts();
  const config = await loadGatewayBankConfig(options.config);
  const incremental = Boolean(options.incremental);
  if (options.dryRun) {
    // Reads the bank to diff against it; never inspects or changes saved progress.
    describePlan(planGatewayBankUpdate(config, incremental ? await readIncrementalBase(options.output) : undefined), config, incremental);
    console.log('Configuration valid. No requests sent; bank and saved progress unchanged.');
  } else {
    const result = await updateGatewayBank(config, {
      outputPath: options.output,
      restart: Boolean(options.restart),
      incremental,
      signal: controller.signal,
      onPlan: (plan) => {
        describePlan(plan, config, incremental);
        if (!plan.collect.length) return;
        console.log(`Progress is saved in ${options.output}.checkpoint.json. Rerun the same command after a failure to resume.`);
        if (options.restart) console.log('Starting over: saved probes will be discarded and the request budget will reset.');
      },
      onResume: ({ completedRequests, totalRequests, requestsSent }) => {
        console.log(`Resuming ${completedRequests}/${totalRequests} saved runs; ${totalRequests - completedRequests} remaining; ${requestsSent}/${config.maxRequests} requests already counted.`);
      },
      onProgress: ({ modelId, phase, run, runs, completedRequests, totalRequests, requestsSent }) => {
        console.log(`[${completedRequests}/${totalRequests}] ${modelId}: ${phase} ${run}/${runs} complete (${requestsSent}/${config.maxRequests} requests sent)`);
      },
      onRetry: ({ modelId, phase, run, attempt, maxAttempts, message }) => {
        console.log(`${modelId}: ${phase} ${run}: ${message}; retrying a fresh run (attempt ${attempt}/${maxAttempts})`);
      },
    });
    console.log(result.changed ? 'Fingerprint bank updated atomically.' : 'Fingerprint bank unchanged.');
    if (result.corpusPath) console.log(`Collected runs kept in ${result.corpusPath}; archive it to refit the bank without new requests.`);
    if (result.requests) {
      console.log(`${result.resumedRuns} saved runs reused; ${result.requestsThisRun} requests this invocation; ${result.requests} requests across the collection.`);
      console.log('Distance envelopes calibrated; sequential early stopping remains disabled pending independent evaluation.');
    }
  }
} catch (error) {
  // Do not dump Error objects, causes, headers, config objects, or provider bodies.
  console.error(error instanceof Error ? error.message : 'Bank update failed');
  process.exitCode = controller.signal.aborted ? 130 : 1;
} finally {
  process.removeListener('SIGINT', abort);
  process.removeListener('SIGTERM', abort);
}
