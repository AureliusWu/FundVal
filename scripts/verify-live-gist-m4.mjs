import { pathToFileURL } from 'node:url';
import { LIVE_GIST_TOKEN_ENV } from './lib/live-gist-m4-scope.mjs';

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
// Deliberately false until the complete built-App dual-Chrome scenario driver
// is implemented, reviewed and approved. Explicit execute flags do not bypass
// this gate. In particular, this preparation never reads a real env token.
export const LIVE_GIST_BROWSER_DRIVER_READY = false;

export function planLiveGistM4(argv = []) {
  let execute = false, approvedLogin = '', newSyntheticOnly = false, cleanupOwned = false, site = '', journal = '';
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (seen.has(option)) return { ok: false, reason: 'live_duplicate_option' };
    seen.add(option);
    if (option === '--execute') execute = true;
    else if (option === '--new-synthetic-only') newSyntheticOnly = true;
    else if (option === '--cleanup-owned') cleanupOwned = true;
    else if (['--approved-login', '--site', '--journal'].includes(option)) {
      const value = argv[++index];
      if (typeof value !== 'string' || !value || value.startsWith('--')) return { ok: false, reason: 'live_option_value_missing' };
      if (option === '--approved-login') approvedLogin = value;
      else if (option === '--site') site = value;
      else journal = value;
    } else return { ok: false, reason: 'live_unknown_option' };
  }
  if (execute && (!LOGIN.test(approvedLogin) || !newSyntheticOnly || !site || !journal)) return { ok: false, reason: 'live_explicit_approval_required' };
  if (cleanupOwned && !execute) return { ok: false, reason: 'live_cleanup_requires_execute' };
  return { ok: true, execute, approvedLogin, newSyntheticOnly, cleanupOwned, site, journal };
}

export function runLiveGistM4Preparation(argv = []) {
  const options = planLiveGistM4(argv);
  if (!options.ok) return { exitCode: 2, report: { status: 'PREPARED_NOT_RUN', reason: options.reason, realRequests: 0, browserContextsStarted: 0 } };
  return { exitCode: options.execute ? 2 : 0, report: {
    status: 'PREPARED_NOT_RUN', reason: options.execute ? 'live_browser_driver_incomplete' : 'live_dry_run_only',
    executionReady: LIVE_GIST_BROWSER_DRIVER_READY, realRequests: 0, browserContextsStarted: 0,
    tokenSource: LIVE_GIST_TOKEN_ENV, tokenRead: false, cleanupRequested: options.cleanupOwned,
    scope: ['exact_authenticated_login', 'one_new_secret_synthetic_gist', 'only_owned_get_patch', 'immutable_legacy_fixture',
      'exclusive_durable_intention_journal', 'serial_requests_mutations_at_least_1000ms_apart', 'unknown_write_read_only_review', 'optional_owned_delete_then_404'],
    requiredBrowserSteps: ['two_independent_playwright_chrome_contexts', 'actual_built_app_ui_and_session_credentials',
      'block_external_providers_and_dev_routes', 'round_trip', 'concurrent_local_changes', 'tombstone_merge', 'offline_change_recovery',
      'real_remote_canonical_hash_readback'],
    forbiddenCapture: ['screenshots', 'trace', 'video', 'token', 'headers', 'url_query', 'holdings_body'],
    limitations: ['browser_driver_not_implemented', 'no_live_account_selected', 'no_real_api_or_browser_validation', 'not_gist_cas'],
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runLiveGistM4Preparation(process.argv.slice(2));
  process.stdout.write(JSON.stringify(result.report, null, 2) + '\n');
  process.exitCode = result.exitCode;
}
