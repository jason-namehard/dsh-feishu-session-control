#!/usr/bin/env node
// Real availability probe for the pinned DeepSeek Harness matrix.
//
// Boots a scratch DSH_HOME with the exact pinned `@deepseek-ai/dsh` +
// `@deepseek-ai/dsh-base`, seeds a minimal bot profile, then runs
// `dist/cli.js doctor` with DSH_LARK_ADAPTER=sdk. The doctor builds the real
// SDK adapter: it creates the JSON-RPC runtime profile, pnpm-installs
// `@deepseek-ai/dsh-sdk-jsonrpc-server` at the pinned version, discovers the
// harness binary and performs a real SDK initialize round-trip.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable as NodeReadable, Writable as NodeWritable } from 'node:stream';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk';
import { readDshCompatibility, rootDir } from './dsh-compat.mjs';

const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

const textResponse = (text) => [
  JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '' }, index: 0, finish_reason: null }] }),
  JSON.stringify({ choices: [{ delta: { content: text }, index: 0, finish_reason: null }] }),
  JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
  '[DONE]',
];

const MAX_FIXTURE_MODEL_REQUESTS = 32;
const shellToolName = process.platform === 'win32' ? 'pwsh' : 'bash';
const acpDeniedCommand = process.platform === 'win32'
  ? "Write-Output 'acp-must-not-run'"
  : 'printf acp-must-not-run';
const approvalRejectedCommand = process.platform === 'win32'
  ? "Write-Output 'must-not-run-approval'"
  : 'printf must-not-run-approval';

function toolInputCommand(toolInput) {
  if (typeof toolInput === 'string') {
    try {
      return JSON.parse(toolInput)?.command;
    } catch {
      return undefined;
    }
  }
  return toolInput?.command;
}

function isRejectedApproval(approval) {
  return approval.callId === 'compat-reject-bash' ||
    toolInputCommand(approval.toolInput) === approvalRejectedCommand;
}

async function startCompatServer() {
  const notifications = [];
  const questions = [];
  const plans = [];
  const approvals = [];
  const modelRequests = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += String(chunk); });
    request.on('end', () => {
      if (request.url === '/notify') {
        notifications.push(JSON.parse(raw));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, chatId: 'compat-chat' }));
        return;
      }
      if (request.url === '/ask') {
        questions.push(JSON.parse(raw));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, answer: 'compat-answer' }));
        return;
      }
      if (request.url === '/plan') {
        plans.push(JSON.parse(raw));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, decision: 'approved', feedback: 'compat-approved' }));
        return;
      }
      if (request.url === '/approval') {
        const approval = JSON.parse(raw);
        approvals.push(approval);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          ok: true,
          outcome: isRejectedApproval(approval)
            ? 'rejected'
            : 'allowed-once',
        }));
        return;
      }
      if (request.url !== '/v1/chat/completions') {
        response.writeHead(404).end();
        return;
      }
      const modelInput = raw.length > 0 ? JSON.parse(raw) : {};
      modelRequests.push(modelInput);
      if (modelRequests.length > MAX_FIXTURE_MODEL_REQUESTS) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          error: {
            message: `compat fixture exceeded ${MAX_FIXTURE_MODEL_REQUESTS} model requests; a state transition matcher is stale`,
          },
        }));
        return;
      }
      const serializedInput = JSON.stringify(modelInput);
      const hasNativeImage = serializedInput.includes('data:image/png;base64') ||
        serializedInput.includes('"image_url"');
      const isAcpTask = serializedInput.includes('Verify ACP text task and approval.');
      const hasAcpToolCall = serializedInput.includes('compat-acp-bash');
      const hasAcpPlanApproval = serializedInput.includes('compat-acp-plan') &&
        serializedInput.includes('compat-approved');
      const isResume = serializedInput.includes('Continue the same session.');
      const hasPersistedFirstTurn =
        serializedInput.includes('compat-call') &&
        serializedInput.includes('tool-ok') &&
        serializedInput.includes('Message sent to compat-chat');
      const isAsk = serializedInput.includes('Call lark_ask_user once.');
      const hasAskResult = serializedInput.includes('compat-ask-call') &&
        serializedInput.includes('compat-answer');
      const isPlan = serializedInput.includes('Call lark_request_plan_approval once.');
      const hasPlanResult = serializedInput.includes('compat-plan-call') &&
        serializedInput.includes('compat-approved');
      const isApprovalReject = serializedInput.includes('Verify rejected approval recovery.');
      const hasRejectPlan = serializedInput.includes('compat-reject-plan') &&
        serializedInput.includes('compat-approved');
      const hasApprovalReject = serializedInput.includes('compat-reject-bash') &&
        approvals.some(isRejectedApproval);
      const unavailableApproval = serializedInput.includes('no approval channel is available');
      const hasNotifyResult = serializedInput.includes('Message sent to compat-chat');
      const events = hasNativeImage
        ? textResponse('acp-image-ok')
        : isAcpTask && hasAcpToolCall
          ? textResponse('acp-task-approval-ok')
          : isAcpTask && hasAcpPlanApproval
            ? [
              JSON.stringify({ choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'compat-acp-bash', type: 'function', function: { name: shellToolName, arguments: JSON.stringify({ command: acpDeniedCommand, description: 'Verify ACP permission rejection', sandbox_permissions: 'danger-full-access', justification: 'Verify that the ACP client receives and rejects this one-shot escalation.' }) } }] }, index: 0, finish_reason: null }] }),
              JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
              '[DONE]',
            ]
            : isAcpTask
              ? [
                JSON.stringify({ choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'compat-acp-plan', type: 'function', function: { name: 'lark_request_plan_approval', arguments: '{"plan":"1. verify ACP plan callback\\n2. request and reject a one-shot escalation"}' } }] }, index: 0, finish_reason: null }] }),
                JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
                '[DONE]',
              ]
        : isResume
        ? textResponse(hasPersistedFirstTurn ? 'resume-ok' : 'resume-history-missing')
        : isApprovalReject && unavailableApproval
          ? textResponse('approval-unavailable')
        : isApprovalReject && hasApprovalReject
          ? textResponse('approval-rejected')
          : isApprovalReject && hasRejectPlan
            ? [
              JSON.stringify({ choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'compat-reject-bash', type: 'function', function: { name: shellToolName, arguments: JSON.stringify({ command: approvalRejectedCommand, description: 'Verify rejection recovery', sandbox_permissions: 'danger-full-access', justification: 'Verify that DSH native approval rejection stops this command.' }) } }] }, index: 0, finish_reason: null }] }),
              JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
              '[DONE]',
            ]
          : isApprovalReject
            ? [
              JSON.stringify({ choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'compat-reject-plan', type: 'function', function: { name: 'lark_request_plan_approval', arguments: '{"plan":"1. request permission\\n2. attempt the high-risk command\\n3. continue safely if rejected"}' } }] }, index: 0, finish_reason: null }] }),
              JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
              '[DONE]',
            ]
        : hasAskResult
          ? textResponse('ask-ok')
          : hasPlanResult
            ? textResponse('plan-ok')
            : isPlan
              ? [
                JSON.stringify({ choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'compat-plan-call', type: 'function', function: { name: 'lark_request_plan_approval', arguments: '{"plan":"1. inspect\\n2. execute"}' } }] }, index: 0, finish_reason: null }] }),
                JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
                '[DONE]',
              ]
          : isAsk
            ? [
              JSON.stringify({ choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'compat-ask-call', type: 'function', function: { name: 'lark_ask_user', arguments: '{"question":"compat question","kind":"text"}' } }] }, index: 0, finish_reason: null }] }),
              JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
              '[DONE]',
            ]
          : hasNotifyResult
          ? textResponse('tool-ok')
          : [
            JSON.stringify({ choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'compat-call', type: 'function', function: { name: 'lark_notify', arguments: '{"text":"compat tool"}' } }] }, index: 0, finish_reason: null }] }),
            JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
            '[DONE]',
          ];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of events) response.write(`data: ${event}\n\n`);
      response.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('compat server has no TCP port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    notifications,
    questions,
    plans,
    approvals,
    modelRequests,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'inherit', 'inherit'],
      ...options,
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${String(code)}`));
    });
  });
}

async function probeAcpRuntime({ harnessBin, workspace, env, modelRequests }) {
  const child = spawn('node', [harnessBin, '--profile', 'dsh-lark-acp'], {
    cwd: workspace,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (!child.stdin || !child.stdout) throw new Error('ACP image probe has no protocol streams');
  child.stderr?.on('data', (chunk) => {
    process.stderr.write(`[probe:acp] ${String(chunk)}`);
  });
  const text = [];
  const permissions = [];
  const conn = new ClientSideConnection(
    () => ({
      requestPermission: async (params) => {
        permissions.push(params);
        const option = params.options.find((candidate) => candidate.kind === 'reject_once');
        if (!option) throw new Error(`ACP permission request has no reject_once option: ${JSON.stringify(params.options)}`);
        return { outcome: { outcome: 'selected', optionId: option.optionId } };
      },
      sessionUpdate: async ({ update }) => {
        if (
          update?.sessionUpdate === 'agent_message_chunk' &&
          update.content?.type === 'text'
        ) text.push(update.content.text);
      },
    }),
    ndJsonStream(
      NodeWritable.toWeb(child.stdin),
      NodeReadable.toWeb(child.stdout),
    ),
  );
  try {
    const initialized = await conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    let session;
    let sessionError;
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      try {
        session = await conn.newSession({ cwd: workspace, mcpServers: [] });
        break;
      } catch (error) {
        sessionError = error;
        if (!String(error).match(/internal error/i)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }
    if (!session) throw sessionError;
    await conn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'Verify ACP text task and approval.' }],
    });
    if (!text.join('').includes('acp-task-approval-ok')) {
      throw new Error(`ACP text task result missing: ${JSON.stringify(text)}`);
    }
    if (
      permissions.length !== 1 ||
      permissions[0]?.toolCall?.toolCallId !== 'compat-acp-bash'
    ) {
      throw new Error(`ACP permission callback mismatch: ${JSON.stringify({
        permissions,
        requests: modelRequests.slice(-3).map((request) => request.messages?.slice(-5).map((message) => ({
          role: message.role,
          content: message.content,
          tool_calls: message.tool_calls,
          tool_call_id: message.tool_call_id,
        }))),
      })}`);
    }
    if (initialized.agentCapabilities?.promptCapabilities?.image !== true) {
      return { nativeImage: false, permissionCount: permissions.length };
    }
    text.length = 0;
    const imageSession = await conn.newSession({ cwd: workspace, mcpServers: [] });
    const onePixelPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    await conn.prompt({
      sessionId: imageSession.sessionId,
      prompt: [
        { type: 'text', text: 'Describe this compatibility image.' },
        { type: 'image', data: onePixelPng, mimeType: 'image/png' },
      ],
    });
    if (!text.join('').includes('acp-image-ok')) {
      throw new Error(`ACP native image result missing: ${JSON.stringify(text)}`);
    }
    return { nativeImage: true, permissionCount: permissions.length };
  } finally {
    child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        resolve();
      }, 3_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

async function main() {
  const compat = readDshCompatibility();
  const rootPackage = JSON.parse(
    readFileSync(join(rootDir(), 'package.json'), 'utf8'),
  );
  const root = await mkdtemp(join(tmpdir(), 'dsh-compat-probe-'));
  const dshHome = join(root, 'dsh');
  const larkHome = join(root, 'lark');
  const workspace = join(root, 'workspace');
  const compatServer = await startCompatServer();
  const env = {
    ...process.env,
    // The scratch profiles workspace grows a package.json dynamically (the
    // bot writes the runtime profile before its own pnpm install), so the
    // workspace lockfile is intentionally re-generated. CI forces
    // `frozen-lockfile` by default; opt out for the scratch workspace only.
    npm_config_frozen_lockfile: 'false',
    DSH_HOME: dshHome,
    DSH_LARK_HOME: larkHome,
    DSH_LARK_ADAPTER: 'sdk',
    DSH_LARK_PROVIDER: 'compat-local',
    DSH_LARK_MODEL: 'compat-model',
    DSH_LARK_WORKSPACE: workspace,
    DSH_LARK_NOTIFY_URL: `${compatServer.url}/notify`,
    DSH_LARK_ASK_URL: `${compatServer.url}/ask`,
    DSH_LARK_PLAN_URL: `${compatServer.url}/plan`,
    DSH_LARK_APPROVAL_URL: `${compatServer.url}/approval`,
    DSH_LARK_NOTIFY_TOKEN: 'compat-token',
    COMPAT_API_KEY: 'compat-local-key',
  };
  delete env.DSH_LARK_DSH_COMMAND;
  delete env.DSH_LARK_DSH_ARGS;

  try {
    // 1. Install the pinned harness + base bundle into the scratch dsh home.
    const profilesRoot = join(dshHome, 'profiles');
    await mkdir(profilesRoot, { recursive: true });
    await writeFile(
      join(profilesRoot, 'package.json'),
      `${JSON.stringify(
        {
          name: 'dsh-compat-probe-profiles',
          private: true,
          // Pin the same pnpm the repo uses so corepack and CI behave alike.
          packageManager: rootPackage.packageManager,
          dependencies: {
            '@deepseek-ai/dsh': compat.harness,
            '@deepseek-ai/dsh-base': compat.harness,
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    // pnpm 10 blocks dependency build scripts by default; the dsh harness
    // ships native modules (node-pty, koffi, protobufjs...), so the scratch
    // workspace opts into running them, exactly like a normal dsh install.
    await writeFile(
      join(profilesRoot, 'pnpm-workspace.yaml'),
      [
        'packages:',
        '  - "*"',
        'dangerouslyAllowAllBuilds: true',
        '',
      ].join('\n'),
      'utf8',
    );
    console.log(`[probe] installing dsh ${compat.harness} into ${dshHome}`);
    await run(pnpmCommand, ['install'], {
      cwd: profilesRoot,
      env,
      shell: process.platform === 'win32',
    });

    // 2. Assert the installed harness version matches the matrix.
    const harnessBin = join(
      profilesRoot,
      'node_modules',
      '@deepseek-ai',
      'dsh',
      'lib',
      'bin.js',
    );
    const versionCheck = spawn('node', [harnessBin, '--version'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const versionOutput = await new Promise((resolve, reject) => {
      let out = '';
      let err = '';
      versionCheck.stdout.on('data', (chunk) => {
        out += String(chunk);
      });
      versionCheck.stderr.on('data', (chunk) => {
        err += String(chunk);
      });
      versionCheck.once('error', reject);
      versionCheck.once('exit', (code) => resolve({ code, out, err }));
    });
    if (versionOutput.code !== 0) {
      throw new Error(`dsh --version failed: ${versionOutput.err || versionOutput.out}`);
    }
    const version = versionOutput.out.trim();
    if (!version.includes(compat.harness)) {
      throw new Error(`dsh version mismatch: got "${version}", expected ${compat.harness}`);
    }
    console.log(`[probe] harness version ok: ${version}`);
    // Configure a local OpenAI-compatible route. This makes the probe keyless
    // while still exercising a real pinned DSH model loop, tool call and resume.
    await writeFile(
      join(dshHome, 'settings.yaml'),
      [
        'llm-pi-ai:',
        '  providers:',
        '    compat-local:',
        '      api: openai-completions',
        `      baseURL: ${compatServer.url}/v1`,
        '      apiKeyEnv: COMPAT_API_KEY',
        '      models:',
        '        - id: compat-model',
        '',
      ].join('\n'),
      'utf8',
    );

    // 3. Seed a minimal bot profile so `doctor` can run its real probe.
    await mkdir(larkHome, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(larkHome, 'config.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          activeProfile: 'default',
          profiles: {
            default: {
              schemaVersion: 1,
              agentKind: 'dsh',
              tenant: 'feishu',
              accounts: {
                appId: 'cli_compat_probe',
                appSecret: 'compat-probe-secret',
              },
              workspaces: { default: workspace },
              preferences: {
                model: 'compat-model',
                stopGraceMs: 5000,
                runTimeoutMs: 300000,
              },
              access: { allowedUsers: [], allowedChats: [], admins: [] },
            },
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    // 4. Real availability probes through both managed protocol adapters.
    for (const adapter of ['sdk', 'acp']) {
      console.log(`[probe] running \`doctor\` (${adapter.toUpperCase()} runtime bootstrap + initialize round-trip)`);
      const doctor = spawn('node', [join(rootDir(), 'dist', 'cli.js'), 'doctor'], {
        env: { ...env, DSH_LARK_ADAPTER: adapter },
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      const doctorCode = await new Promise((resolve) => {
        doctor.once('exit', (code) => resolve(code ?? 1));
      });
      if (doctorCode !== 0) {
        throw new Error(`${adapter} doctor exited with code ${doctorCode}`);
      }
    }
    const acpResult = await probeAcpRuntime({
      harnessBin,
      workspace,
      env,
      modelRequests: compatServer.modelRequests,
    });
    console.log(`[probe] acp text task + permission callback ok (${acpResult.permissionCount} request)`);
    console.log(acpResult.nativeImage
      ? '[probe] acp native PNG capability + content block ok'
      : '[probe] pinned ACP runtime advertises no image capability; bridge fail-closed attachment rejection remains required');
    if (compatServer.plans.length !== 1) {
      throw new Error(`ACP plan callback count mismatch: ${compatServer.plans.length}`);
    }
    const sdkPlanBaseline = compatServer.plans.length;
    const sdkApprovalBaseline = compatServer.approvals.length;
    // 5. Run a complete SDK tool turn, then resume the same durable session.
    const { DeepSeekHarness } = await import('@deepseek-ai/dsh-sdk-client');
    const createHarness = () => new DeepSeekHarness({
      dshBin: harnessBin,
      profile: 'dsh-lark-sdk',
      processCwd: workspace,
      env,
      cwd: workspace,
      provider: 'compat-local',
      model: 'compat-model',
    });
    const initializeHarness = async (harness) => {
      // pi-ai providers register asynchronously after the JSON-RPC server
      // starts. Poll initialize on the same subprocess (re-spawning would
      // restart the race), mirroring SdkDshAdapter's production workaround.
      const client = harness.client;
      client.start();
      let initialized = false;
      let initError;
      for (let attempt = 1; attempt <= 6; attempt += 1) {
        try {
          await client.initialize({ cwd: workspace, provider: 'compat-local', model: 'compat-model' });
          initialized = true;
          break;
        } catch (error) {
          initError = error;
          if (!String(error).match(/no adapter registered/i)) throw error;
          await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        }
      }
      if (!initialized) throw initError;
      harness.initialized = Promise.resolve();
    };

    const firstHarness = createHarness();
    try {
      await initializeHarness(firstHarness);
      const first = await firstHarness.run('Call lark_notify once.', { sessionId: 'compat-session' });
      if (first.finalResponse !== 'tool-ok') {
        throw new Error(`unexpected tool-turn response: ${JSON.stringify(first.finalResponse)}`);
      }
      if (compatServer.notifications.length !== 1) {
        throw new Error(`lark_notify execution count mismatch: ${compatServer.notifications.length}`);
      }
      console.log('[probe] sdk lark_notify turn ok');
      const resumed = await firstHarness.run('Continue the same session.', { sessionId: 'compat-session' });
      if (resumed.finalResponse !== 'resume-ok') {
        throw new Error(`unexpected in-process resumed response: ${JSON.stringify({
          finalResponse: resumed.finalResponse,
          events: resumed.events,
        })}`);
      }
      console.log('[probe] sdk live-session resume ok');
    } finally {
      await firstHarness.close();
    }

    // The pinned SDK server does not expose an API for rehydrating an existing
    // named JSONL session in a new process. It must fail explicitly with the
    // persisted-log collision that run-flow recognizes and self-heals from;
    // silently starting an empty session would lose context.
    const harness = createHarness();
    try {
      await initializeHarness(harness);
      let reopenError;
      try {
        const reopened = await harness.run('Continue the same session.', { sessionId: 'compat-session' });
        reopenError = reopened.events.find((event) => event.type === 'turn/end')
          ?.data?.reason?.error?.message;
      } catch (error) {
        reopenError = error instanceof Error ? error.message : String(error);
      }
      if (!/persisted log.*id collision/i.test(String(reopenError)) &&
        !/^session\s+[\x22\x27\x60][-A-Za-z0-9_]+[\x22\x27\x60]\s+already exists$/i.test(String(reopenError))) {
        throw new Error(`unexpected close/reopen result: ${JSON.stringify({
          error: reopenError,
        })}`);
      }
      console.log('[probe] sdk close/reopen collision is explicit; bridge fresh-session self-heal remains required');
      const asked = await harness.run('Call lark_ask_user once.', { sessionId: 'compat-ask-session' });
      if (asked.finalResponse !== 'ask-ok') {
        throw new Error(`unexpected ask-tool response: ${JSON.stringify(asked.finalResponse)}`);
      }
      if (compatServer.questions.length !== 1) {
        throw new Error(`lark_ask_user execution count mismatch: ${compatServer.questions.length}`);
      }
      const rejected = await harness.run(
        'Verify rejected approval recovery.',
        { sessionId: 'compat-approval-reject-session' },
      );
      const nativeRejection = rejected.finalResponse === 'approval-rejected' &&
        rejected.events.some((event) => (
          event.type === 'approval/decided' && event.data?.outcome === 'rejected'
        ));
      const unavailableRejection = rejected.finalResponse === 'approval-unavailable' &&
        rejected.events.some((event) => event.type === 'approval/decided' && event.data?.outcome === 'unavailable');
      if (!nativeRejection && !unavailableRejection) {
        throw new Error(`native approval rejection did not terminate cleanly: final=${JSON.stringify(rejected.finalResponse)} decisions=${JSON.stringify(rejected.events.filter((event) => event.type === 'approval/decided').map((event) => event.data?.outcome))} approvals=${compatServer.approvals.length} baseline=${sdkApprovalBaseline}`);
      }
      const sdkApprovals = compatServer.approvals.slice(sdkApprovalBaseline);
      if (
        compatServer.plans.length !== sdkPlanBaseline + 1 ||
        (nativeRejection ? sdkApprovals.length !== 1 : sdkApprovals.length > 1) ||
        sdkApprovals.some((approval) => !isRejectedApproval(approval)) ||
        compatServer.notifications.length !== 1
      ) {
        throw new Error(
          `approval rejection recovery counts mismatch: plans=${compatServer.plans.length}, approvals=${compatServer.approvals.length}, notifications=${compatServer.notifications.length}`,
        );
      }
      if (sdkApprovals.length === 1) {
        const approval = sdkApprovals[0];
        if (
          approval.toolName !== shellToolName || approval.callId !== 'compat-reject-bash' ||
          !approval.reason
        ) {
          throw new Error(`incomplete native approval payload: ${JSON.stringify(approval)}`);
        }
      }
      console.log(`[probe] sdk task/notify/ask/explicit-plan/${nativeRejection ? 'native-approval-stop' : 'approval-unavailable-fail-closed'}/resume ok against local OpenAI-compatible fixture`);
    } finally {
      await harness.close();
    }
    console.log(
      `[probe] ok: sdk-server ${compat.sdkServer} and acp ${compat.acp} initialize against dsh ${compat.harness}`,
    );
  } finally {
    await compatServer.close();
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
