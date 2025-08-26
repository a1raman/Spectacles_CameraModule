// @input Asset.InternetModule internetModule
// @input string postUrl = "http://218.145.184.243:9999/upload"
// @input int    healthMaxRetry = 5
// @input float  healthRetrySec = 2.0
// @input int    sendFps = 8

const cameraModule = require('LensStudio:CameraModule');

let camTex, provider, lastSend = 0, streaming = false;
//동기
let inFlight = false;
let seq = 0;

function now(){ return getTime(); }


//------------ 동기 ----------
function sendBase64Jpeg(b64, s){
  const req = new Request(script.postUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
      'X-Seq': '' + s,             //프레임 순번 추가
    },
    body: b64,
  });
  script.internetModule.fetch(req)
    .catch(e => print('[POST ERR] ' + e))
    .then(_ => { inFlight = false; });  //전송 끝나면 락 해제
}

function encodeAndSend(tex){
  if (inFlight) return;        //이전 작업 끝나기 전엔 스킵(최신만 유지)
  inFlight = true;
  const thisSeq = ++seq;       //프레임 시퀀스 증가

  Base64.encodeTextureAsync(
    tex,
    function(encoded){ sendBase64Jpeg(encoded, thisSeq); },
    function(err){ inFlight = false; print('[Base64 ERR] ' + err); },
    CompressionQuality.HighQuality,
    EncodingType.Jpg
  );
}


//-------네트워크 문제점 진단 (잘되면 필요없음)-------
function delay(sec, fn) {
  var ev = script.createEvent('DelayedCallbackEvent');
  ev.bind(fn);
  ev.reset(sec);
}

function logInternetStatus() {
  var ok = global.deviceInfoSystem.isInternetAvailable();
  print('[NET] device internetAvailable = ' + ok);
  global.deviceInfoSystem.onInternetStatusChanged.add(function (ev) {
    print('[NET] statusChanged -> ' + ev.isInternetAvailable);
  });
}

function fetchStatus(url, label) {
  if (!url) { print('[FETCH ' + label + ' ERR] empty url'); return; }
  var req = new Request(url, { method: 'GET' });
  script.internetModule.fetch(req).then(function (res) {
    print('[FETCH ' + label + '] status=' + res.status + ' url=' + url);
  }).catch(function (e) {
    print('[FETCH ' + label + ' ERR] ' + e + ' url=' + url);
  });
}

function normalizePostUrl(){
  if (!script.postUrl) return;
  var u = (''+script.postUrl).replace(/\/+$/,''); // 끝 슬래시 제거
  // 이중 /upload → 한 번만
  if (u.endsWith('/upload/upload')) u = u.slice(0, -7); // '/upload' 제거
  // 맨 끝이 /upload 아니면 붙여주기(원하면 주석처리 가능)
  if (!u.endsWith('/upload')) u += '/upload';
  script.postUrl = u;
  print('[URL] normalized postUrl=' + script.postUrl);
}

//---------- Health체크 (이것도 진단용) ----------
function healthUrl() {
  var base = (script.postUrl || '').split('/upload')[0];
  var url  = base ? (base + '/health') : '';
  print('[HEALTH] url=' + url);
  return url;
}

function healthCheckAndStart(retry = 0){
  const url = healthUrl();
  if (!url){ print('[HEALTH ERR] invalid postUrl'); return; }

  const req = new Request(url, { method: 'GET' });
  script.internetModule.fetch(req).then(function(res){
    print('[HEALTH] status=' + res.status);
    if (res.status === 200){
      startStreaming();
    } else {
      if (retry < (script.healthMaxRetry || 5)){
        const wait = (script.healthRetrySec || 2.0);
        print('[HEALTH] retry in ' + wait + 's (' + (retry+1) + ')');
        delay(wait, function(){ healthCheckAndStart(retry+1); });
      } else {
        print('[HEALTH FAIL] give up. check ngrok/URL/firewall');
      }
    }
  }).catch(function(e){
    if (retry < (script.healthMaxRetry || 5)){
      const wait = (script.healthRetrySec || 2.0);
      print('[HEALTH ERR] ' + e + ' → retry in ' + wait + 's (' + (retry+1) + ')');
      delay(wait, function(){ healthCheckAndStart(retry+1); });
    } else {
      print('[HEALTH FAIL] give up. check network/permissions');
    }
  });
}

//----------업로드----------
function sendBase64Jpeg(b64){
  const req = new Request(script.postUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: b64,
  });
  script.internetModule.fetch(req).catch(e => print('[POST ERR] '+ e));
}

function encodeAndSend(tex){
  Base64.encodeTextureAsync(
    tex,
    function(encoded){ sendBase64Jpeg(encoded); },
    function(err){ print('[Base64 ERR] ' + err); },
    CompressionQuality.HighQuality,
    EncodingType.Jpg
  );
}

function startStreaming(){
  if (streaming) return;
  streaming = true;

  provider.onNewFrame.add(function(){
    const period = 1.0 / Math.max(1, (script.sendFps || 8));
    if (now() - lastSend < period) return;
    lastSend = now();
    encodeAndSend(camTex);
  });

  print('[OK] Streaming to ' + script.postUrl);
}

//---------- 메인 ----------
script.createEvent('OnStartEvent').bind(function(){
  if (!script.internetModule){ print('[ERR] InternetModule input not assigned'); return; }

  //URL 정규화
  normalizePostUrl();
  print('[OK] Base64 stream prepared → ' + script.postUrl);

  //네트워크 진단
  logInternetStatus();
  fetchStatus('https://httpbin.org/status/200', 'httpbin');  // 일반 인터넷 통과 여부
  fetchStatus(healthUrl(), 'ngrok-health');                   // ngrok /health 접근 여부

  //카메라 시작
  const req = CameraModule.createCameraRequest(); 
  req.cameraId = CameraModule.CameraId.Default_Color;
  req.imageSmallerDimension = 640;

  camTex = cameraModule.requestCamera(req);
  if (!camTex){ print('[ERR] requestCamera returned null'); return; }

  provider = camTex.control;
  if (!provider || !provider.onNewFrame){ print('[ERR] CameraTextureProvider unavailable'); return; }

  //헬스체크 후 스트리밍 시작
  healthCheckAndStart(0);
});
