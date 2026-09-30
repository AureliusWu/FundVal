import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function validateCandidateRun(run, { repository, sha, runId, workflowId }) {
  const sameRepository = value => typeof value === 'string' && value.toLowerCase() === repository.toLowerCase();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')
    || !/^[0-9a-f]{40}$/.test(sha || '') || !/^[1-9]\d*$/.test(String(runId || ''))
    || String(run?.id) !== String(runId) || run.workflow_id !== workflowId
    || run.path !== '.github/workflows/ci.yml' || !sameRepository(run.repository?.full_name)
    || !sameRepository(run.head_repository?.full_name) || run.event !== 'push'
    || run.head_branch !== 'main' || run.head_sha !== sha || run.status !== 'completed'
    || run.conclusion !== 'success' || !Number.isInteger(run.run_attempt) || run.run_attempt < 1) {
    throw new Error('Release requires a successful origin main-push CI run for the exact requested SHA.');
  }
  return { sha, runId: String(runId), attempt: String(run.run_attempt), artifactName: `fundval-candidate-${sha}-${run.run_attempt}` };
}

export function assertMainAncestor(sha) {
  if (!/^[0-9a-f]{40}$/.test(sha || '')) throw new Error('Invalid candidate SHA.');
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, 'origin/main'], { stdio: 'ignore' });
  } catch (_) { throw new Error('Candidate SHA is not an ancestor of the current protected main.'); }
}

async function main() {
  const { GITHUB_REPOSITORY: repository, CANDIDATE_SHA: sha, CANDIDATE_RUN_ID: runId, GH_TOKEN: token } = process.env;
  if (!token) throw new Error('Missing Actions read token.');
  // Validate untrusted dispatch inputs before interpolating into API paths.
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')
    || !/^[0-9a-f]{40}$/.test(sha || '') || !/^[1-9]\d*$/.test(runId || '')) {
    throw new Error('Invalid release dispatch identity.');
  }
  const get = async path => {
    const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Candidate provenance API failed (${response.status}).`);
    return response.json();
  };
  const [run, workflow] = await Promise.all([get(`actions/runs/${runId}`), get('actions/workflows/ci.yml')]);
  const candidate = validateCandidateRun(run, { repository, sha, runId, workflowId: workflow.id });
  assertMainAncestor(sha);
  const artifacts = await get(`actions/runs/${runId}/artifacts?per_page=100`);
  const matches = artifacts.artifacts?.filter(artifact => artifact.name === candidate.artifactName && !artifact.expired) || [];
  if (matches.length !== 1 || matches[0].workflow_run?.head_sha !== sha) {
    throw new Error('Candidate artifact is missing, expired, duplicated or tied to a different SHA/attempt. Re-run all CI jobs to seal a new immutable candidate.');
  }
  if (!process.env.GITHUB_OUTPUT) throw new Error('Missing GitHub Actions output destination.');
  await appendFile(process.env.GITHUB_OUTPUT, `sha=${candidate.sha}\nrun_id=${candidate.runId}\nattempt=${candidate.attempt}\nartifact_name=${candidate.artifactName}\n`);
  process.stdout.write(`Approved origin CI provenance for ${sha} (run ${runId}, attempt ${candidate.attempt}).\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
