'use strict';

// 零依赖 HTTP 服务：页面、健康路径、审计接口。
const http = require('http');
const { audit } = require('./bisimulation');
const { runTraceDirection } = require('./trace-inclusion');
const { samples } = require('./samples');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req, limit = 1024 * 256) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('BODY_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/healthz') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/samples') {
    sendJson(res, 200, samples);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/audit') {
    let payload;
    try {
      const raw = await readBody(req);
      payload = JSON.parse(raw);
    } catch (e) {
      sendJson(res, 400, { ok: false, equivalent: null, errors: [{ code: 'BAD_JSON', field: 'body', side: null, message: '请求体不是合法 JSON' }], rounds: [], eliminatedPairs: [], firstEliminated: null, initialPairs: [], traceInclusion: null });
      return;
    }
    const result = audit(payload.procA, payload.procB);

    // 可选单向轨迹包含检查：traceDirection 'A' = A 的可观察轨迹须由 B 承接。
    // 缺省时只做普通弱互模拟审计；规程校验失败时不进行轨迹检查并清除该结果。
    const direction = payload.traceDirection;
    if (direction === undefined || direction === null || direction === '') {
      result.traceInclusion = null;
    } else if (!result.ok) {
      result.traceInclusion = null;
    } else if (direction !== 'A' && direction !== 'B') {
      result.ok = false;
      result.equivalent = null;
      result.errors = [{ code: 'TRACE_DIRECTION_INVALID', field: 'traceDirection', side: null, message: "轨迹检查方向必须为 'A'（A 的轨迹由 B 承接）或 'B'" }];
      result.rounds = [];
      result.eliminatedPairs = [];
      result.firstEliminated = null;
      result.initialPairs = [];
      result.traceInclusion = null;
    } else {
      result.traceInclusion = runTraceDirection(payload.procA, payload.procB, direction);
    }
    // 输入无效时同样以 200 返回结构化问题集合（结论字段为空，表示已清除旧结论）；
    // 仅结构错误（非 JSON）才返回 400。
    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(require('fs').readFileSync(require('path').join(__dirname, 'public', 'index.html')));
    return;
  }

  sendJson(res, 404, { error: 'NOT_FOUND' });
});

server.listen(PORT, HOST, () => {
  console.log(`silent-jump-audit listening on http://${HOST}:${PORT}`);
});

module.exports = server;
