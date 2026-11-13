/* 飞书中转服务：只做两件事 —— ① 提供授权回调页 ② 把工作台的请求转发给 open.feishu.cn（加上 CORS 头）。
   无状态、不存储任何数据：App Secret / 授权码 / 文档内容只在转发瞬间经过，不落盘。 */
'use strict';
const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 8787;
const UPSTREAM = 'open.feishu.cn';
const ALLOW_RE = /^\/open-apis\//;

const CALLBACK_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>飞书授权回调 · 直播运营工作台</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#F0F7F4;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.box{background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(46,196,182,.12);max-width:560px;width:100%;padding:34px 32px}
.brand{font-size:12.5px;color:#17877C;font-weight:600;margin-bottom:6px}
h1{font-size:19px;color:#12161A;margin-bottom:14px}
p{font-size:13px;color:#5B6B78;line-height:1.7;margin:8px 0}
.err{background:#FDECEC;border:1px solid #F5C6C6;color:#C92A2A;padding:12px 14px;border-radius:10px;font-size:13px}
.codebox{margin:16px 0;background:#EFFAF8;border:1.5px dashed #2EC4B6;border-radius:12px;padding:16px;text-align:center}
.code{font-family:Consolas,monospace;font-size:20px;font-weight:700;color:#0E7C72;word-break:break-all;user-select:all}
.btn{display:inline-block;margin-top:14px;background:#2EC4B6;color:#fff;border:none;border-radius:10px;padding:10px 22px;font-size:14px;font-weight:600;cursor:pointer}
.btn:active{transform:scale(.97)}
.tip{font-size:12px;color:#93A2AE;margin-top:6px}
ol{padding-left:20px;font-size:13px;color:#5B6B78;line-height:1.9}
</style></head><body><div class="box">
<div class="brand">直播运营工作台 · 飞书授权中转</div>
<div id="content"></div>
</div>
<script>
var q = new URLSearchParams(location.search);
var code = q.get('code'), err = q.get('error');
var el = document.getElementById('content');
if (code) {
  el.innerHTML = '<h1>✅ 飞书授权成功</h1>'
    + '<p>下面是本次授权码（约 5 分钟内有效）。请回到 <b>直播运营工作台 → 设置 → 飞书授权</b>，把它粘贴进「② 授权码」输入框，点「完成授权」。</p>'
    + '<div class="codebox"><div class="code" id="c">' + code + '</div>'
    + '<button class="btn" id="b">📋 一键复制授权码</button>'
    + '<div class="tip">点击或长按全选复制；复制后可关闭本页面</div></div>'
    + '<p style="font-size:12px;color:#93A2AE">安全说明：本页面只展示授权码，不保存任何数据。</p>';
  document.getElementById('b').onclick = function(){
    var t = code;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(function(){ document.getElementById('b').textContent = '✅ 已复制，请回到工作台粘贴'; },
        function(){ var r=document.createRange(); r.selectNode(document.getElementById('c')); getSelection().removeAllRanges(); getSelection().addRange(r); });
    } else {
      var r=document.createRange(); r.selectNode(document.getElementById('c')); getSelection().removeAllRanges(); getSelection().addRange(r);
      try{document.execCommand('copy');document.getElementById('b').textContent='✅ 已复制，请回到工作台粘贴';}catch(e){}
    }
  };
  document.getElementById('b').click();
} else {
  el.innerHTML = '<h1>' + (err ? '⚠️ 授权未完成' : '飞书授权回调页') + '</h1>'
    + (err ? '<div class="err">飞书返回错误：' + (err || '') + (q.get('error_description') ? '（' + q.get('error_description') + '）' : '') + '</div>'
           : '<p>这里是「直播运营工作台」的飞书 OAuth 回调页。正常情况下你会在授权完成后自动跳转到这里并看到授权码。</p>')
    + '<p style="font-size:12px;color:#93A2AE">如果你是手动打开本页面的：请回到工作台设置页，点「打开飞书授权页」重新开始。</p>';
}
</script></body></html>`;

function cors(res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function forward(payload, cb){
  const path = String(payload.path || '');
  const method = String(payload.method || 'GET').toUpperCase();
  const headers = { 'Content-Type': 'application/json' };
  if (payload.token) headers['Authorization'] = 'Bearer ' + String(payload.token).slice(0, 512);
  const body = (method === 'POST' && payload.body) ? JSON.stringify(payload.body) : null;
  if (body) headers['Content-Length'] = Buffer.byteLength(body);
  const req = https.request({ hostname: UPSTREAM, port: 443, path, method, headers, timeout: 25000 }, (fr) => {
    const chunks = [];
    fr.on('data', c => chunks.push(c));
    fr.on('end', () => cb(null, Buffer.concat(chunks).toString('utf8')));
  });
  req.on('timeout', () => { req.destroy(new Error('upstream timeout')); });
  req.on('error', e => cb(e));
  if (body) req.write(body);
  req.end();
}

const server = http.createServer((req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  let u;
  try { u = new URL(req.url, 'http://localhost'); } catch (e) { res.writeHead(400); return res.end('bad request'); }

  if (u.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, ts: Date.now() }));
  }
  if (u.pathname === '/callback' || u.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(CALLBACK_HTML);
  }
  if (u.pathname === '/proxy' && req.method === 'POST') {
    const chunks = []; let size = 0; let aborted = false;
    req.on('data', c => {
      size += c.length;
      if (size > 8 * 1024 * 1024) { aborted = true; res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'payload too large' })); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'invalid json' })); }
      const path = String(payload.path || '');
      if (!ALLOW_RE.test(path)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'path not allowed', path }));
      }
      forward(payload, (err, bodyText) => {
        if (err) { res.writeHead(502, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'upstream error', msg: err.message })); }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(bodyText);
      });
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

server.listen(PORT, '0.0.0.0', () => console.log('[feishu-relay] listening on 0.0.0.0:' + PORT));
