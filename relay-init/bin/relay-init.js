#!/usr/bin/env node
/**
 * relay-init
 * ==========
 * Interactive CLI that:
 *   1. Verifies wrangler is installed (installs if missing)
 *   2. Clones relay-worker into the current directory
 *   3. Prompts for the publisher API key
 *   4. Sets RELAY_API_KEY as a Cloudflare Worker secret
 *   5. Creates the KV namespace for SOM cache
 *   6. Patches wrangler.toml with the real KV namespace ID
 *   7. Deploys the Worker
 *   8. Prints the route setup instructions
 */

import { createRequire } from 'module';
import { fileURLToPath }  from 'url';
import { dirname, join }  from 'path';
import { existsSync }     from 'fs';
import { readFile, writeFile } from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const isDryRun = process.argv.includes('--dry-run');

// Dynamic imports (ESM)
const { default: chalk }   = await import('chalk');
const { default: prompts } = await import('prompts');
const { default: ora }     = await import('ora');
const { execa }            = await import('execa');

const RELAY_API_URL   = 'https://relay-backend.onrender.com';
const WORKER_REPO     = 'https://github.com/hastikdan/relay-worker.git';
const WORKER_DIR_NAME = 'relay-worker';

// ── Helpers ───────────────────────────────────────────────────────────────────

function header() {
  console.log('');
  console.log(chalk.bold.white('  ┌─────────────────────────────────────┐'));
  console.log(chalk.bold.white('  │  ') + chalk.bold.greenBright('Relay Worker Setup') + chalk.bold.white('                   │'));
  console.log(chalk.bold.white('  │  ') + chalk.gray('The structured layer between your') + chalk.bold.white('    │'));
  console.log(chalk.bold.white('  │  ') + chalk.gray('content and AI.') + chalk.bold.white('                      │'));
  console.log(chalk.bold.white('  └─────────────────────────────────────┘'));
  console.log('');
}

async function run(cmd, args, opts = {}) {
  if (isDryRun) {
    console.log(chalk.gray(`  [dry-run] ${cmd} ${args.join(' ')}`));
    return { stdout: 'dry-run' };
  }
  return execa(cmd, args, { stdio: 'inherit', ...opts });
}

async function runCapture(cmd, args, opts = {}) {
  if (isDryRun) return { stdout: 'dry-run', stderr: '' };
  return execa(cmd, args, opts);
}

// ── Step 1: Check wrangler ────────────────────────────────────────────────────

async function checkWrangler() {
  const spinner = ora('Checking for wrangler CLI...').start();
  try {
    const { stdout } = await runCapture('wrangler', ['--version']);
    spinner.succeed(chalk.green(`wrangler found: ${stdout.trim()}`));
    return true;
  } catch {
    spinner.warn('wrangler not found — installing globally...');
    await run('npm', ['install', '-g', 'wrangler']);
    console.log(chalk.green('  ✓ wrangler installed'));
    return true;
  }
}

// ── Step 2: Clone worker repo ────────────────────────────────────────────────

async function cloneWorker() {
  if (existsSync(WORKER_DIR_NAME)) {
    console.log(chalk.yellow(`  ⚠ ./${WORKER_DIR_NAME} already exists — using existing directory`));
    return WORKER_DIR_NAME;
  }
  const spinner = ora(`Cloning relay-worker into ./${WORKER_DIR_NAME}...`).start();
  await run('git', ['clone', WORKER_REPO, WORKER_DIR_NAME]);
  spinner.succeed(chalk.green(`Worker cloned to ./${WORKER_DIR_NAME}`));
  return WORKER_DIR_NAME;
}

// ── Step 3: Install worker deps ───────────────────────────────────────────────

async function installDeps(dir) {
  const spinner = ora('Installing Worker dependencies...').start();
  await run('npm', ['install'], { cwd: dir });
  spinner.succeed(chalk.green('Dependencies installed'));
}

// ── Step 4: Get API key ───────────────────────────────────────────────────────

async function getApiKey() {
  console.log('');
  console.log(chalk.gray('  Find your API key at: ' + chalk.cyan('https://hastikdan.github.io/relay/app/') + ' → Setup tab'));
  console.log('');
  const { apiKey } = await prompts({
    type: 'password',
    name: 'apiKey',
    message: 'Paste your Relay API key (rly_...)',
    validate: v => v.startsWith('rly_') ? true : 'Key must start with rly_',
  });
  if (!apiKey) { console.log(chalk.red('\n  Aborted.')); process.exit(1); }

  // Validate key against the API
  const spinner = ora('Validating API key...').start();
  try {
    const res = await fetch(`${RELAY_API_URL}/publishers/me/worker-config`, {
      headers: { 'X-Relay-Key': apiKey },
    });
    if (!res.ok) {
      spinner.fail(chalk.red('Invalid API key — check the Setup tab in your Relay dashboard'));
      process.exit(1);
    }
    const config = await res.json();
    spinner.succeed(chalk.green(`Key valid — publisher: ${chalk.bold(config.domain)}`));
    return { apiKey, config };
  } catch {
    spinner.fail(chalk.red('Could not reach Relay API — check your internet connection'));
    process.exit(1);
  }
}

// ── Step 5: Set Worker secret ─────────────────────────────────────────────────

async function setWorkerSecret(dir, apiKey) {
  const spinner = ora('Setting RELAY_API_KEY as Cloudflare Worker secret...').start();
  if (isDryRun) {
    spinner.succeed(chalk.green('Secret set (dry-run)'));
    return;
  }
  const proc = execa('wrangler', ['secret', 'put', 'RELAY_API_KEY'], { cwd: dir, stdin: 'pipe' });
  proc.stdin.write(apiKey + '\n');
  proc.stdin.end();
  await proc;
  spinner.succeed(chalk.green('RELAY_API_KEY secret set in Cloudflare'));
}

// ── Step 6: Create KV namespace ───────────────────────────────────────────────

async function createKVNamespace(dir) {
  const spinner = ora('Creating KV namespace for SOM cache...').start();
  try {
    const { stdout } = await runCapture('wrangler', ['kv:namespace', 'create', 'SOM_CACHE'], { cwd: dir });
    // Parse: id = "abc123"
    const match = stdout.match(/id\s*=\s*"([^"]+)"/);
    if (!match) throw new Error('Could not parse KV namespace ID');
    const kvId = match[1];
    spinner.succeed(chalk.green(`KV namespace created: ${chalk.bold(kvId)}`));
    return kvId;
  } catch (err) {
    spinner.warn(chalk.yellow('Could not auto-create KV namespace. You may need to run:'));
    console.log(chalk.gray(`  cd ${dir} && wrangler kv:namespace create SOM_CACHE`));
    console.log(chalk.gray('  Then update wrangler.toml with the returned id'));
    return null;
  }
}

// ── Step 7: Patch wrangler.toml ───────────────────────────────────────────────

async function patchWranglerToml(dir, kvId) {
  if (!kvId) return;
  const tomlPath = join(dir, 'wrangler.toml');
  let toml = await readFile(tomlPath, 'utf8');
  toml = toml.replace('REPLACE_WITH_YOUR_KV_NAMESPACE_ID', kvId);
  await writeFile(tomlPath, toml);
  console.log(chalk.green(`  ✓ wrangler.toml updated with KV namespace ID`));
}

// ── Step 8: Deploy Worker ─────────────────────────────────────────────────────

async function deployWorker(dir) {
  const spinner = ora('Deploying Worker to Cloudflare...').start();
  try {
    const { stdout } = await runCapture('wrangler', ['deploy'], { cwd: dir });
    // Parse deployed URL from wrangler output
    const urlMatch = stdout.match(/https:\/\/[^\s]+workers\.dev/);
    const workerUrl = urlMatch ? urlMatch[0] : null;
    spinner.succeed(chalk.green('Worker deployed' + (workerUrl ? `: ${chalk.bold(workerUrl)}` : '')));
    return workerUrl;
  } catch {
    spinner.fail(chalk.red('Worker deploy failed — check wrangler output above'));
    process.exit(1);
  }
}

// ── Step 9: Print route instructions ─────────────────────────────────────────

function printRouteInstructions(domain, workerUrl) {
  console.log('');
  console.log(chalk.bold.white('  ── Final Step: Add Route in Cloudflare ────────────────'));
  console.log('');
  console.log('  1. Go to ' + chalk.cyan('https://dash.cloudflare.com'));
  console.log(`  2. Select your domain: ${chalk.bold(domain)}`);
  console.log('  3. Navigate to: Workers & Pages → Routes → Add Route');
  console.log('  4. Set route pattern: ' + chalk.bold(`${domain}/*`));
  console.log('  5. Assign Worker: ' + chalk.bold('relay-worker'));
  console.log('  6. Click Save');
  console.log('');
  if (workerUrl) {
    console.log('  Test your Worker directly:');
    console.log(chalk.gray(`  curl -A "ClaudeBot/1.0" ${workerUrl}/`));
    console.log(chalk.gray('  # Should return SOM JSON instead of HTML'));
  }
  console.log('');
  console.log('  Once your route is active, agent traffic will appear in your dashboard at:');
  console.log('  ' + chalk.cyan('https://hastikdan.github.io/relay/app/'));
  console.log('');
  console.log(chalk.bold.greenBright('  Relay is active. AI agents will now receive structured content.'));
  console.log('');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  header();

  if (isDryRun) {
    console.log(chalk.yellow('  Running in dry-run mode — no changes will be made\n'));
  }

  await checkWrangler();
  const dir = await cloneWorker();
  await installDeps(dir);
  const { apiKey, config } = await getApiKey();
  await setWorkerSecret(dir, apiKey);
  const kvId = await createKVNamespace(dir);
  await patchWranglerToml(dir, kvId);
  const workerUrl = await deployWorker(dir);
  printRouteInstructions(config.domain, workerUrl);
}

main().catch(err => {
  console.error(chalk.red('\n  Error: ' + err.message));
  process.exit(1);
});
