// Adapted from Paperclip's openclaw-gateway adapter at pinned commit
// 6abeb67334348dcb6fde2d591a27ffc7efc7118d (MIT).
import { createPublicKey, generateKeyPairSync, sign } from "crypto";

export function validateGatewayConfig(config) {
  let url; try { url = new URL(config?.url); } catch { throw new Error("Gateway URL is invalid"); }
  if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error("Gateway URL must use ws or wss");
  if (url.protocol === 'ws:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) throw new Error("Non-loopback Gateway must use wss");
  if (typeof config.token !== 'string' || config.token.length < 16) throw new Error("Gateway token must contain at least 16 characters");
  return { url: url.toString(), token: config.token, agentId: safe(config.agentId, "agentId"), sessionKeyStrategy: ['issue', 'run', 'fixed'].includes(config.sessionKeyStrategy) ? config.sessionKeyStrategy : 'issue', fixedSessionKey: config.fixedSessionKey || 'hq' };
}

export function createDeviceIdentity(privateKey = null) {
  const pair = privateKey ? { privateKey, publicKey: createPublicKey(privateKey) } : generateKeyPairSync('ed25519');
  const publicDer = pair.publicKey.export({ type: 'spki', format: 'der' }); const raw = publicDer.subarray(-32);
  return { deviceId: raw.toString('hex').slice(0, 32), publicKey: raw.toString('base64url'), privateKey: pair.privateKey };
}

export function buildConnectFrame({ challenge, token, device, requestId = 'connect-1' }) {
  const payload = `${challenge}:${device.deviceId}`; const signature = sign(null, Buffer.from(payload), device.privateKey).toString('base64url');
  return { type: 'req', id: requestId, method: 'connect', params: { protocolVersion: 4, client: { id: 'openclaw-hq', mode: 'backend', version: '1' }, role: 'operator', scopes: ['operator.admin'], auth: { token }, device: { id: device.deviceId, publicKey: device.publicKey, signature, signedPayload: payload } } };
}

export function resolveGatewaySessionKey({ strategy = 'issue', fixedSessionKey = 'hq', agentId, runId, issueId }) {
  const body = strategy === 'run' ? `hq:run:${safe(runId, 'runId')}` : strategy === 'issue' && issueId ? `hq:issue:${safe(issueId, 'issueId')}` : safe(fixedSessionKey, 'fixedSessionKey');
  return body.startsWith('agent:') ? body : `agent:${safe(agentId, 'agentId')}:${body}`;
}

export function buildAgentFrame({ agentId, runId, issueId, message, sessionKeyStrategy = 'issue', fixedSessionKey = 'hq' }) {
  return { type: 'req', id: `agent-${safe(runId, 'runId')}`, method: 'agent', params: { agentId: safe(agentId, 'agentId'), idempotencyKey: safe(runId, 'runId'), sessionKey: resolveGatewaySessionKey({ strategy: sessionKeyStrategy, fixedSessionKey, agentId, runId, issueId }), message: String(message || '') } };
}

export async function exerciseGatewayContract({ config, transport, challenge = 'synthetic-challenge', run, timeoutMs = 1000, autoPair = true }) {
  const valid = validateGatewayConfig(config); const device = createDeviceIdentity(); const events = [];
  await bounded(() => transport.request(buildConnectFrame({ challenge, token: valid.token, device })), timeoutMs);
  const frame = buildAgentFrame({ agentId: valid.agentId, runId: run.runId, issueId: run.issueId, message: run.message, sessionKeyStrategy: valid.sessionKeyStrategy, fixedSessionKey: valid.fixedSessionKey });
  let response;
  try { response = await bounded(() => transport.request(frame, (event) => events.push(normalizeGatewayEvent(event))), timeoutMs); }
  catch (error) {
    if (!autoPair || error.code !== 'PAIRING_REQUIRED') throw error;
    await bounded(() => transport.request({ type: 'req', id: `pair-${run.runId}`, method: 'device.pair.approve', params: { requestId: safe(error.requestId, 'pairingRequestId') } }), timeoutMs);
    response = await bounded(() => transport.request(frame, (event) => events.push(normalizeGatewayEvent(event))), timeoutMs);
  }
  await bounded(() => transport.request({ type: 'req', id: `wait-${run.runId}`, method: 'agent.wait', params: { runId: response.runId, timeoutMs } }), timeoutMs);
  return { version: 1, runId: run.runId, sessionKey: frame.params.sessionKey, events, factoryEntrypoint: 'scripts/openclaw-factory.mjs', workerEntrypoint: './run.sh' };
}

export function normalizeGatewayEvent(frame) {
  if (frame?.type !== 'event' || typeof frame.event !== 'string') throw new Error('Invalid Gateway event');
  return { event: frame.event, seq: Number.isInteger(frame.seq) ? frame.seq : null, runId: frame.payload?.runId || null, stream: frame.payload?.stream || null, text: typeof frame.payload?.text === 'string' ? frame.payload.text.slice(0, 2000) : null };
}
async function bounded(fn, timeoutMs) { let timer; try { return await Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => { timer = setTimeout(() => { const error = new Error('OpenClaw Gateway timeout'); error.code = 'GATEWAY_TIMEOUT'; reject(error); }, timeoutMs); })]); } finally { clearTimeout(timer); } }
function safe(value, label) { const text = String(value || ''); if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/.test(text)) throw new Error(`${label} is invalid`); return text; }
