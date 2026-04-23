// ══════════════════════════════
//  STATE
// ══════════════════════════════
const STORE = 'sr_room_';
const SESS  = 'sr_sess';

let R = {
  roomCode:   null,
  isHost:     false,
  tracks:     [],
  curIdx:     -1,
  playing:    false,
  repeatMode: 0,
  dismissed:  false,
};

// YT
let ytPlayer   = null;
let ytReady    = false;
let progTimer  = null;
let isSeeking  = false;

// Peer
let peer       = null;
let hostConn   = null;
let guestConns = [];
let guestNames = {};

// 재연결
let reconnTimer       = null;
let synced            = false;
let guestMemberCount  = 0;
let pendingSyncCurIdx = -2;    // GUEST_SYNC 전송 시점의 curIdx (-2 = 대기 없음)

// ══════════════════════════════
//  YOUTUBE
// ══════════════════════════════
function onYouTubeIframeAPIReady() { ytReady = true; }

function buildYT(videoId, autoplay, seekTo) {
  document.getElementById('playerError').style.display = 'none';
  if (ytPlayer) { try { ytPlayer.destroy(); } catch(e){} ytPlayer = null; }
  document.getElementById('ytMount').innerHTML = '<div id="yt"></div>';
  const loadStart = Date.now();

  ytPlayer = new YT.Player('yt', {
    videoId,
    playerVars: { autoplay: autoplay?1:0, controls:0, rel:0, fs:0, modestbranding:1, playsinline:1, enablejsapi:1, origin: location.origin },
    events: {
      onReady(e) {
        applyVol(parseInt(document.getElementById('volBar').value));
        // 게스트가 재생 중인 방장에 동기화할 때 플레이어 로딩 시간만큼 seekTo를 앞으로 보정
        const elapsed = (!R.isHost && autoplay) ? (Date.now() - loadStart) / 1000 : 0;
        const adjustedSeek = seekTo + elapsed;
        if (adjustedSeek > 0) e.target.seekTo(adjustedSeek, true);
        if (autoplay) {
          e.target.playVideo();
        }
        document.getElementById('btnPlay').disabled = false;
        startProg();
        setThumb(videoId);
      },
      onStateChange(e) {
        const st = e.data;
        if (st === YT.PlayerState.ENDED) {
          if (R.isHost) handleEnd();
          return;
        }
        if (st === YT.PlayerState.PLAYING) {
          R.playing = true; setPlayIcon(true);
          if (R.isHost) bcast({ cmd:'play', time: getCurTime() });
        }
        if (st === YT.PlayerState.PAUSED) {
          R.playing = false; setPlayIcon(false);
          if (R.isHost) bcast({ cmd:'pause', time: getCurTime() });
        }
      },
      onError() {
        document.getElementById('playerError').style.display = 'block';
      }
    }
  });
}

function startProg() {
  clearInterval(progTimer);
  let tickCount = 0;
  progTimer = setInterval(() => {
    if (!ytPlayer || isSeeking) return;
    try {
      const c = ytPlayer.getCurrentTime?.() ?? 0;
      const d = ytPlayer.getDuration?.()   ?? 0;
      if (d > 0) {
        document.getElementById('progressBar').max   = d;
        document.getElementById('progressBar').value = c;
        document.getElementById('timeCur').textContent = fmt(c);
        document.getElementById('timeDur').textContent = fmt(d);
      }
      // 방장은 5초마다 현재 재생 시간을 게스트에게 브로드캐스트 (드리프트 보정용)
      if (R.isHost && R.playing && ++tickCount >= 10) {
        tickCount = 0;
        bcast({ cmd: 'time_sync', time: c });
      }
    } catch(e){}
  }, 500);
}

function setThumb(vid) {
  const img = document.getElementById('albumImg');
  img.src = 'https://img.youtube.com/vi/' + vid + '/mqdefault.jpg';
  img.style.display = 'block';
  document.getElementById('defIcon').style.display = 'none';
}

function getCurTime() {
  if (ytPlayer?.getCurrentTime) try { return ytPlayer.getCurrentTime(); } catch(e){}
  return 0;
}

function handleEnd() {
  if (R.repeatMode === 1) { playAt(R.curIdx); }
  else if (R.curIdx < R.tracks.length - 1) { playAt(R.curIdx + 1); }
  else if (R.repeatMode === 2) { playAt(0); }
  else {
    R.playing = false; R.curIdx = -1;
    setPlayIcon(false);
    document.getElementById('btnPlay').disabled = true;
    document.getElementById('albumImg').style.display = 'none';
    document.getElementById('defIcon').style.display = 'block';
    document.getElementById('trackTitle').innerHTML = '<span class="t-idle">재생할 곡을 선택하세요</span>';
    document.getElementById('trackSub').style.display = 'none';
    clearInterval(progTimer);
    saveRoom();
    bcast({ cmd:'stop' });
  }
}

// ══════════════════════════════
//  PEERJS
// ══════════════════════════════
function initPeer(id) {
  return new Promise((res, rej) => {
    peer = new Peer(id, { debug: 0 });
    let opened = false;
    peer.on('open', () => { opened = true; res(); });
    peer.on('error', err => {
      if (!opened) { rej(err); return; }
      // open 이후의 에러는 대부분 일시적 (예: 시그널링 서버 끊김)
      console.warn('[peer error]', err && err.type, err && err.message);
    });
    // 시그널링 서버 연결 끊김 → 자동 재연결 (게스트가 방장을 다시 찾을 수 있게)
    peer.on('disconnected', () => {
      if (peer && !peer.destroyed) {
        try { peer.reconnect(); } catch(e){}
      }
    });
    peer.on('connection', conn => onGuestConnect(conn));
  });
}

function onGuestConnect(conn) {
  conn.on('open', () => {
    guestConns.push(conn);
    guestNames[conn.peer] = '게스트 ' + guestConns.length;
    updateChip(); renderMembers();
    conn.send({ type: 'INIT', state: packState() });
    bcast({ cmd:'member_update', memberCount: 1 + guestConns.length });
    showToast('🎧 ' + guestNames[conn.peer] + ' 입장!');
    // 진단: 게스트 입장 시점에 방장 플레이어 상태를 로그 (bug #3 디버그용)
    try {
      const st = ytPlayer?.getPlayerState?.();
      console.log('[host] guest connected. R.playing=', R.playing, 'ytState=', st);
    } catch(e){}
  });
  conn.on('data', msg => {
    if (msg.type === 'GUEST_PLAY')  { if (ytPlayer) try { ytPlayer.playVideo();  } catch(e){} }
    if (msg.type === 'GUEST_PAUSE') { if (ytPlayer) try { ytPlayer.pauseVideo(); } catch(e){} }
    if (msg.type === 'GUEST_SYNC')  { conn.send({ type: 'SYNC_RESP', state: packState() }); }
  });
  conn.on('close', () => {
    const name = guestNames[conn.peer] || '게스트';
    delete guestNames[conn.peer];
    guestConns = guestConns.filter(c => c !== conn);
    updateChip(); renderMembers();
    bcast({ cmd:'member_update', memberCount: 1 + guestConns.length });
    showToast('👋 ' + name + ' 퇴장');
  });
  conn.on('error', () => {
    delete guestNames[conn.peer];
    guestConns = guestConns.filter(c => c !== conn);
    updateChip(); renderMembers();
    bcast({ cmd:'member_update', memberCount: 1 + guestConns.length });
  });
}

function connectToHost(code) {
  return new Promise((res, rej) => {
    hostConn = peer.connect('syncroom-' + code, { reliable: true });
    const t = setTimeout(() => rej(new Error('timeout')), 3500);
    hostConn.on('open', () => { clearTimeout(t); res(); });
    hostConn.on('data', msg => {
      if (msg.type === 'INIT')      applyHostState(msg.state, true);
      if (msg.type === 'SYNC_RESP') applyHostState(msg.state, false);
      if (msg.type === 'CMD')       applyHostCmd(msg);
      if (msg.type === 'DISMISS')   onDismissed();
    });
    hostConn.on('close', () => {
      if (!R.dismissed) {
        updateChip('warn');
        showToast('⚠️ 방장 연결 끊김, 재연결 시도 중...');
        reconnTimer = setTimeout(() => guestReconnect(R.roomCode, 0), 2000);
      }
    });
    hostConn.on('error', rej);
  });
}

function bcast(msg) {
  guestConns.forEach(c => { try { c.send({ type:'CMD', ...msg }); } catch(e){} });
}

function applyHostState(state, isInit) {
  // SYNC_RESP 레이스 컨디션 감지
  const prevCurIdx = R.curIdx;

  R.tracks  = state.tracks  || [];
  R.curIdx  = state.curIdx  ?? -1;
  R.playing = state.playing ?? false;

  if (state.memberCount) {
    guestMemberCount = state.memberCount;
    renderMembers();
  }

  renderList();

  if (isInit) {
    if (R.curIdx >= 0) {
      const t = R.tracks[R.curIdx];
      document.getElementById('trackTitle').textContent = t.title;
      document.getElementById('trackSub').style.display = 'block';
      setThumb(t.videoId);
    }
  } else {
    // SYNC_RESP: GUEST_SYNC 이후 곡이 바뀌었으면 로드하지 않음 (stale 무시)
    const syncStale = (pendingSyncCurIdx !== -2 && prevCurIdx !== pendingSyncCurIdx);
    pendingSyncCurIdx = -2;
    if (syncStale) return;

    const time = state.time || 0;
    if (R.curIdx >= 0 && R.tracks.length > 0) {
      loadTrack(R.curIdx, R.playing, time);
    }
  }
}

function applyHostCmd(msg) {
  if (msg.cmd === 'load') {
    R.tracks = msg.tracks || R.tracks;
    R.curIdx = msg.idx;
    renderList();
    loadTrack(msg.idx, msg.auto, msg.time || 0);
  } else if (msg.cmd === 'play') {
    if (!ytPlayer && R.curIdx >= 0 && R.tracks.length > 0) {
      loadTrack(R.curIdx, true, msg.time || 0);
    } else if (ytPlayer) {
      try { ytPlayer.seekTo(msg.time || 0, true); ytPlayer.playVideo(); } catch(e){}
    }
    R.playing = true; setPlayIcon(true);
  } else if (msg.cmd === 'pause') {
    if (ytPlayer) try { ytPlayer.pauseVideo(); } catch(e){}
    R.playing = false; setPlayIcon(false);
  } else if (msg.cmd === 'seek') {
    if (ytPlayer) try { ytPlayer.seekTo(msg.time, true); } catch(e){}
  } else if (msg.cmd === 'list') {
    R.tracks = msg.tracks; R.curIdx = msg.curIdx;
    renderList();
  } else if (msg.cmd === 'member_update') {
    guestMemberCount = msg.memberCount || 1;
    renderMembers();
  } else if (msg.cmd === 'time_sync') {
    // 방장의 주기적 시간 브로드캐스트 — 2초 이상 차이날 때만 보정
    if (ytPlayer && R.playing) {
      try {
        const guestTime = ytPlayer.getCurrentTime?.() ?? 0;
        if (Math.abs(guestTime - msg.time) > 2) {
          ytPlayer.seekTo(msg.time, true);
        }
      } catch(e){}
    }
  } else if (msg.cmd === 'stop') {
    if (ytPlayer) try { ytPlayer.stopVideo(); } catch(e){}
    R.playing = false; R.curIdx = -1;
    setPlayIcon(false);
    document.getElementById('btnPlay').disabled = true;
    document.getElementById('albumImg').style.display = 'none';
    document.getElementById('defIcon').style.display = 'block';
    document.getElementById('trackTitle').innerHTML = '<span class="t-idle">재생할 곡을 선택하세요</span>';
    document.getElementById('trackSub').style.display = 'none';
    clearInterval(progTimer); renderList();
  }
}

function onDismissed() {
  R.dismissed = true;
  clearTimeout(reconnTimer);
  sessionStorage.removeItem(SESS);
  if (peer) peer.destroy();
  showToast('방이 삭제됐어요');
  setTimeout(() => location.reload(), 1200);
}

function guestReconnect(code, attempt) {
  if (R.dismissed) return;
  if (attempt >= 5) {
    setStatus('재연결 실패. 코드를 다시 입력해주세요.');
    sessionStorage.removeItem(SESS);
    return;
  }
  setStatus('재연결 중... (' + (attempt + 1) + '/5)');
  if (peer) { peer.destroy(); peer = null; }
  initPeer('guest-' + Date.now())
    .then(() => connectToHost(code))
    .then(() => {
      saveSession();
      if (!document.getElementById('room').classList.contains('visible')) {
        enterRoom();
      }
      updateChip(); showToast('🔄 재연결됐어요!'); setStatus('');
    })
    .catch(() => {
      if (peer) { peer.destroy(); peer = null; }
      if (!R.dismissed) reconnTimer = setTimeout(() => guestReconnect(code, attempt + 1), 3000);
    });
}

function packState() {
  return { tracks: R.tracks, curIdx: R.curIdx, playing: R.playing, time: getCurTime(), memberCount: 1 + guestConns.length };
}

function updateChip(status) {
  const ch = document.getElementById('peerChip');
  if (R.isHost) {
    const n = guestConns.length;
    ch.textContent = n > 0 ? '● ' + n + '명 연결' : '● 대기 중';
    ch.className = 'peer-chip' + (n > 0 ? ' on' : '');
  } else {
    if (status === 'warn') { ch.textContent = '● 연결 끊김'; ch.className = 'peer-chip warn'; }
    else { ch.textContent = '● 연결됨'; ch.className = 'peer-chip on'; }
  }
}

// ══════════════════════════════
//  ROOM
// ══════════════════════════════
function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({length:6}, () => c[Math.floor(Math.random()*c.length)]).join('');
}

async function createRoom() {
  const code = genCode();
  setStatus('방을 여는 중...');
  try {
    await initPeer('syncroom-' + code);
    R.roomCode = code; R.isHost = true; R.tracks = []; R.curIdx = -1;
    saveRoom(); saveSession(); enterRoom();
    showToast('🎛️ 방 생성! 코드: ' + code);
    setStatus('');
  } catch(e) {
    setStatus('⚠️ 연결 실패. 잠시 후 다시 시도해주세요.');
  }
}

async function joinRoom() {
  const code = document.getElementById('joinInput').value.trim().toUpperCase();
  if (code.length !== 6) { showToast('⚠️ 6자리 코드를 입력해주세요'); return; }
  setStatus('연결 중...');
  try {
    await initPeer('guest-' + Date.now());
    await connectToHost(code);
    R.roomCode = code; R.isHost = false;
    saveSession(); enterRoom(); updateChip();
    showToast('🎧 입장!'); setStatus('');
  } catch(e) {
    setStatus('❌ 방을 찾을 수 없어요.');
    if (peer) { peer.destroy(); peer = null; }
  }
}

function enterRoom() {
  document.getElementById('landing').style.display = 'none';
  document.getElementById('room').classList.add('visible');
  document.getElementById('roomBadge').style.display = 'flex';
  document.getElementById('roomCodeDisplay').textContent = R.roomCode;
  document.getElementById('roleChip').textContent = R.isHost ? '🎛 방장' : '🎧 게스트';
  document.getElementById('leaveBtn').textContent = R.isHost ? '🗑 방 삭제' : '🚪 나가기';

  if (R.isHost) {
    document.getElementById('addForm').style.display = 'flex';
    document.getElementById('guestLock').style.display = 'none';
    document.getElementById('btnRepeat').style.display = 'inline-flex';
    document.getElementById('btnPrev').disabled = false;
    document.getElementById('btnNext').disabled = false;
  } else {
    document.getElementById('addForm').style.display = 'none';
    document.getElementById('guestLock').style.display = 'block';
    document.getElementById('btnPrev').disabled = true;
    document.getElementById('btnPrev').style.opacity = '.3';
    document.getElementById('btnNext').disabled = true;
    document.getElementById('btnNext').style.opacity = '.3';
    document.getElementById('progressBar').disabled = true;
    document.getElementById('btnPlay').style.display = 'none';
    document.getElementById('btnSync').style.display = 'flex';
  }

  // 모바일에서는 미니 플레이어 지원 불가 → 버튼 숨김
  const miniBtn = document.getElementById('miniBtn');
  if (miniBtn) miniBtn.style.display = isMobile() ? 'none' : '';

  const sv = localStorage.getItem('sr_vol') || '80';
  document.getElementById('volBar').value = sv;
  document.getElementById('volLabel').textContent = sv + '%';
  renderList(); renderMembers();
}

function saveRoom() {
  if (!R.roomCode) return;
  localStorage.setItem(STORE + R.roomCode, JSON.stringify({ tracks: R.tracks, curIdx: R.curIdx, playing: R.playing, ts: Date.now() }));
  if (R.isHost) localStorage.setItem('sr_lasthost', R.roomCode);
}

function saveSession() {
  sessionStorage.setItem(SESS, JSON.stringify({ roomCode: R.roomCode, isHost: R.isHost }));
}

// ══════════════════════════════
//  PLAYBACK
// ══════════════════════════════
function loadTrack(idx, auto, seekTo) {
  if (idx < 0 || idx >= R.tracks.length) return;
  const t = R.tracks[idx];
  R.curIdx = idx; R.playing = auto;

  document.getElementById('trackTitle').textContent = t.title;
  document.getElementById('trackSub').style.display = 'block';
  document.getElementById('timeCur').textContent = '0:00';
  document.getElementById('timeDur').textContent = '0:00';
  document.getElementById('progressBar').value = 0;
  document.getElementById('btnPlay').disabled = false;
  setPlayIcon(auto);
  document.getElementById('playerError').style.display = 'none';
  renderList();
  if (R.isHost) saveRoom();
  syncMiniPlayer();

  const go = () => buildYT(t.videoId, auto, seekTo);
  ytReady ? go() : (function wait(){ setTimeout(() => ytReady ? go() : wait(), 150); })();
}

function playAt(idx) {
  if (!R.isHost) return;
  loadTrack(idx, true, 0);
  bcast({ cmd:'load', idx, tracks: R.tracks, auto: true, time: 0 });
}

function hostCmd(cmd) {
  if (R.isHost) {
    if (cmd === 'prev' && R.curIdx > 0) playAt(R.curIdx - 1);
    if (cmd === 'next') {
      if (R.repeatMode === 1) playAt(R.curIdx);
      else if (R.curIdx < R.tracks.length - 1) playAt(R.curIdx + 1);
      else if (R.repeatMode === 2) playAt(0);
      else handleEnd();
    }
  }
}

function handlePlay() {
  if (R.isHost) {
    // 방어: ytPlayer가 없거나 망가져 있으면 현재 곡을 재로드 (사용자 제스처 컨텍스트 유지)
    if (!ytPlayer) {
      if (R.curIdx >= 0 && R.tracks.length > 0) loadTrack(R.curIdx, true, 0);
      return;
    }
    try {
      const st = ytPlayer.getPlayerState();
      if (st === YT.PlayerState.PLAYING) ytPlayer.pauseVideo();
      else ytPlayer.playVideo();
    } catch(e){ console.warn('[handlePlay host]', e); }
  } else {
    if (!hostConn) return;
    try { hostConn.send({ type: R.playing ? 'GUEST_PAUSE' : 'GUEST_PLAY' }); } catch(e){}
  }
}

function guestSync() {
  document.getElementById('btnSync').style.display = 'none';
  document.getElementById('btnPlay').style.display = 'flex';
  document.getElementById('btnPlay').disabled = false;
  synced = true;

  showToast('🔄 동기화 중...');

  if (hostConn) {
    // SYNC_RESP 수신 전에 'load' CMD로 곡이 바뀌는 경우를 감지하기 위해 현재 curIdx 저장
    pendingSyncCurIdx = R.curIdx;
    try { hostConn.send({ type: 'GUEST_SYNC' }); } catch(e){}
  } else {
    showToast('⚠️ 방장과 연결되지 않았어요');
  }
}

function applyVol(v) {
  if (ytPlayer?.setVolume) try { ytPlayer.setVolume(v); } catch(e){}
}

// ══════════════════════════════
//  REPEAT
// ══════════════════════════════
function toggleRepeat() {
  if (!R.isHost) return;
  R.repeatMode = (R.repeatMode + 1) % 3;
  const rb = document.getElementById('btnRepeat');
  document.getElementById('iconRepeatNone').style.display = R.repeatMode === 0 ? 'block' : 'none';
  document.getElementById('iconRepeatOne').style.display  = R.repeatMode === 1 ? 'block' : 'none';
  document.getElementById('iconRepeatAll').style.display  = R.repeatMode === 2 ? 'block' : 'none';
  rb.style.opacity = R.repeatMode === 0 ? '.4' : '1';
  rb.title = ['반복 없음','한 곡 반복','전체 반복'][R.repeatMode];
}

// ══════════════════════════════
//  TRACKS
// ══════════════════════════════
function getVid(url) {
  const ps = [/[?&]v=([^&#]+)/, /youtu\.be\/([^?&#]+)/, /embed\/([^?&#]+)/, /shorts\/([^?&#]+)/];
  for (const p of ps) { const m = url.match(p); if (m) return m[1]; }
  return null;
}

function addTrack() {
  if (!R.isHost) return;
  const url   = document.getElementById('ytUrl').value.trim();
  const title = document.getElementById('ytTitle').value.trim();
  if (!url) { showToast('⚠️ URL을 입력해주세요'); return; }
  const vid = getVid(url);
  if (!vid) { showToast('⚠️ 올바른 YouTube URL이 아니에요'); return; }
  const t = { id: Date.now(), title: title || 'YouTube 트랙', videoId: vid, url };
  R.tracks.push(t);
  document.getElementById('ytUrl').value = '';
  document.getElementById('ytTitle').value = '';
  saveRoom(); renderList();
  bcast({ cmd:'list', tracks: R.tracks, curIdx: R.curIdx });
  showToast('✅ ' + t.title);
}

function delTrack(idx, e) {
  e.stopPropagation(); if (!R.isHost) return;
  const name = R.tracks[idx].title;
  R.tracks.splice(idx, 1);
  if (R.curIdx === idx) { if (ytPlayer) try { ytPlayer.stopVideo(); } catch(e){} R.curIdx = -1; }
  else if (R.curIdx > idx) R.curIdx--;
  saveRoom(); renderList();
  bcast({ cmd:'list', tracks: R.tracks, curIdx: R.curIdx });
  showToast('🗑 ' + name);
}

function moveTrack(idx, dir, e) {
  e.stopPropagation(); if (!R.isHost) return;
  const ni = idx + dir;
  if (ni < 0 || ni >= R.tracks.length) return;
  [R.tracks[idx], R.tracks[ni]] = [R.tracks[ni], R.tracks[idx]];
  if (R.curIdx === idx) R.curIdx = ni;
  else if (R.curIdx === ni) R.curIdx = idx;
  saveRoom(); renderList();
  bcast({ cmd:'list', tracks: R.tracks, curIdx: R.curIdx });
}

// ══════════════════════════════
//  RENDER
// ══════════════════════════════
function renderList() {
  const el = document.getElementById('playlistEl');
  document.getElementById('trackCount').textContent = R.tracks.length + '곡';
  if (!R.tracks.length) { el.innerHTML = '<div class="empty-pl">아직 곡이 없어요</div>'; return; }
  el.innerHTML = R.tracks.map((t, i) => `
    <div class="pl-item ${i === R.curIdx ? 'active' : ''}" onclick="${R.isHost ? 'playAt(' + i + ')' : ''}">
      <span class="pl-num">${i === R.curIdx ? '▶' : i+1}</span>
      <div class="pl-info"><div class="pl-name">${esc(t.title)}</div></div>
      ${R.isHost ? `<div class="pl-actions" onclick="event.stopPropagation()">
        <button class="pl-btn" onclick="moveTrack(${i},-1,event)">▲</button>
        <button class="pl-btn" onclick="moveTrack(${i},1,event)">▼</button>
        <button class="pl-btn del" onclick="delTrack(${i},event)">✕</button>
      </div>` : ''}
    </div>`).join('');
}

function renderMembers() {
  const el = document.getElementById('memberList');
  if (R.isHost) {
    const guests = Object.values(guestNames);
    document.getElementById('memberCount').textContent = (1 + guests.length) + '명';
    el.innerHTML = `<div class="member-item">
      <div class="member-avatar host">🎛</div>
      <div class="member-name">방장</div>
      <span class="member-badge badge-host">방장</span>
    </div>` + guests.map(n => `<div class="member-item">
      <div class="member-avatar guest">🎧</div>
      <div class="member-name">${esc(n)}</div>
      <span class="member-badge badge-guest">게스트</span>
    </div>`).join('');
  } else {
    const total = guestMemberCount > 0 ? guestMemberCount : 1;
    document.getElementById('memberCount').textContent = total + '명';
    let html = `<div class="member-item">
      <div class="member-avatar host">🎛</div>
      <div class="member-name">방장</div>
      <span class="member-badge badge-host">방장</span>
    </div>`;
    const guestCount = total - 1;
    for (let i = 0; i < guestCount; i++) {
      const name = i === 0 ? '나' : '게스트 ' + (i + 1);
      html += `<div class="member-item">
        <div class="member-avatar guest">🎧</div>
        <div class="member-name">${name}</div>
        <span class="member-badge badge-guest">게스트</span>
      </div>`;
    }
    el.innerHTML = html;
  }
}

// ══════════════════════════════
//  IMPORT / EXPORT
// ══════════════════════════════
function exportList() {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify({ version:2, tracks: R.tracks }, null, 2)], {type:'application/json'}));
  a.download = 'syncroom_' + R.roomCode + '_' + Date.now() + '.json';
  a.click(); showToast('📤 내보냈어요');
}
function importList(e) {
  if (!R.isHost) return;
  const file = e.target.files[0]; if (!file) return;
  const r = new FileReader();
  r.onload = ev => {
    try {
      const d = JSON.parse(ev.target.result);
      if (!d.tracks) throw 0;
      R.tracks = d.tracks; saveRoom(); renderList();
      bcast({ cmd:'list', tracks: R.tracks, curIdx: R.curIdx });
      showToast('📥 ' + d.tracks.length + '곡 불러옴');
    } catch { showToast('❌ 파일을 읽을 수 없어요'); }
  };
  r.readAsText(file); e.target.value = '';
}

// ══════════════════════════════
//  MINI PLAYER
// ══════════════════════════════
let miniWin = null;
let miniBC  = null;

function isMobile() {
  return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function openMiniPlayer() {
  // 모바일은 팝업 창 미지원 → 새 탭으로 열리면서 메인 탭이 백그라운드로 가 YT가 멈춤
  if (isMobile()) {
    showToast('⚠️ 미니 플레이어는 PC에서만 사용할 수 있어요');
    return;
  }
  if (!miniBC) {
    miniBC = new BroadcastChannel('sr_mini');
    miniBC.onmessage = e => {
      const cmd = e.data.cmd;
      if (cmd === 'play' || cmd === 'pause') {
        if (R.isHost) {
          handlePlay_host(cmd === 'play');
        } else {
          if (hostConn) try { hostConn.send({ type: cmd === 'play' ? 'GUEST_PLAY' : 'GUEST_PAUSE' }); } catch(ex){}
        }
      }
      if (cmd === 'prev') hostCmd('prev');
      if (cmd === 'next') hostCmd('next');
    };
  }

  if (miniWin && !miniWin.closed) { miniWin.focus(); syncMiniPlayer(); return; }

  miniWin = window.open('', 'sr_mini', 'width=300,height=180,resizable=no,toolbar=no,menubar=no,location=no,status=no');
  if (!miniWin) { showToast('⚠️ 팝업 차단됨. 브라우저에서 허용해주세요.'); return; }

  const t = R.tracks[R.curIdx];
  const title = t ? t.title : '재생 중인 곡 없음';
  const html = `<!DOCTYPE html><html lang="ko"><head>
<meta charset="UTF-8"><title>SyncRoom 미니</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/static/pretendard.css">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#1a1814;color:#fff;font-family:'Pretendard',-apple-system,sans-serif;
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  height:100vh;gap:14px;padding:20px;user-select:none}
#ttl{font-size:13px;font-weight:600;text-align:center;max-width:220px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#sub{font-size:11px;color:rgba(255,255,255,.4);text-align:center}
.btns{display:flex;align-items:center;gap:10px}
.btn{background:rgba(255,255,255,.1);border:none;color:#fff;border-radius:10px;
  width:38px;height:38px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .12s}
.btn:hover{background:rgba(255,255,255,.22)}
.btn.play{width:48px;height:48px;border-radius:50%;background:#fff;color:#1a1814}
.btn.play:hover{background:#e8e8e8}
</style></head><body>
<div id="ttl">${title.replace(/</g,'&lt;')}</div>
<div id="sub">${R.playing?'재생 중':'일시정지'}</div>
<div class="btns">
  <button class="btn" onclick="send('prev')"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg></button>
  <button class="btn play" id="bPlay" onclick="toggle()">
    <svg id="iPlay" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" ${R.playing?'style="display:none"':''}><path d="M8 5v14l11-7z"/></svg>
    <svg id="iPause" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" ${R.playing?'':'style="display:none"'}><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
  </button>
  <button class="btn" onclick="send('next')"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="transform:scaleX(-1)"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg></button>
</div>
<script>
const bc = new BroadcastChannel('sr_mini');
let playing = ${R.playing};
function setP(p){ playing=p; document.getElementById('iPlay').style.display=p?'none':'block'; document.getElementById('iPause').style.display=p?'block':'none'; document.getElementById('sub').textContent=p?'재생 중':'일시정지'; }
bc.onmessage = e => { if(e.data.type==='state'){ document.getElementById('ttl').textContent=e.data.title||'—'; setP(e.data.playing); } };
function toggle(){ bc.postMessage({cmd: playing?'pause':'play'}); }
function send(cmd){ bc.postMessage({cmd}); }
window.onbeforeunload = () => bc.close();
<\/script></body></html>`;

  miniWin.document.open(); miniWin.document.write(html); miniWin.document.close();
}

function syncMiniPlayer() {
  if (!miniBC) return;
  const t = R.tracks[R.curIdx];
  miniBC.postMessage({ type:'state', title: t?.title || '—', playing: R.playing });
}

function handlePlay_host(play) {
  if (!ytPlayer) return;
  try { play ? ytPlayer.playVideo() : ytPlayer.pauseVideo(); } catch(e){}
}

// ══════════════════════════════
//  UTILS
// ══════════════════════════════
function setPlayIcon(playing) {
  document.getElementById('iconPlay').style.display  = playing ? 'none'  : 'block';
  document.getElementById('iconPause').style.display = playing ? 'block' : 'none';
  syncMiniPlayer();
}

function fmt(s) {
  if (isNaN(s) || s < 0) return '0:00';
  return Math.floor(s/60) + ':' + String(Math.floor(s%60)).padStart(2,'0');
}

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function copyCode() {
  navigator.clipboard.writeText(R.roomCode)
    .then(() => showToast('📋 ' + R.roomCode + ' 복사됨'))
    .catch(() => showToast('코드: ' + R.roomCode));
}

function setStatus(msg) { document.getElementById('connStatus').innerHTML = msg; }

function confirmLeave() {
  if (R.isHost) {
    showModal('방 삭제', '방을 삭제하면 게스트도 끊어져요. 계속할까요?', () => {
      guestConns.forEach(c => { try { c.send({ type:'DISMISS' }); } catch(e){} });
      localStorage.removeItem(STORE + R.roomCode);
      localStorage.removeItem('sr_lasthost');
      sessionStorage.removeItem(SESS);
      setTimeout(() => { if (peer) peer.destroy(); location.reload(); }, 400);
    });
  } else {
    showModal('방 나가기', '방에서 나가시겠어요?', () => {
      sessionStorage.removeItem(SESS);
      if (peer) peer.destroy();
      location.reload();
    });
  }
}

function showModal(title, msg, cb) {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalMsg').textContent   = msg;
  document.getElementById('modal').classList.add('open');
  document.getElementById('modalOk').onclick = () => { closeModal(); cb(); };
}
function closeModal() { document.getElementById('modal').classList.remove('open'); }
document.getElementById('modal').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });

let toastT = null;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2800);
}

// ══════════════════════════════
//  INIT
// ══════════════════════════════
window.addEventListener('DOMContentLoaded', () => {
  const pb = document.getElementById('progressBar');
  pb.addEventListener('mousedown',  () => isSeeking = true);
  pb.addEventListener('touchstart', () => isSeeking = true, { passive:true });
  pb.addEventListener('mouseup',   () => isSeeking = false);
  pb.addEventListener('touchend',  () => isSeeking = false);
  pb.addEventListener('change', () => {
    const v = parseFloat(pb.value);
    if (R.isHost && ytPlayer?.seekTo) {
      try { ytPlayer.seekTo(v, true); } catch(e){}
      bcast({ cmd:'seek', time: v });
    }
    isSeeking = false;
  });

  document.getElementById('volBar').addEventListener('input', e => {
    const v = parseInt(e.target.value);
    document.getElementById('volLabel').textContent = v + '%';
    applyVol(v);
    localStorage.setItem('sr_vol', v);
  });

  document.getElementById('joinInput').addEventListener('keydown', e => { if (e.key==='Enter') joinRoom(); });
  document.getElementById('ytUrl').addEventListener('keydown',    e => { if (e.key==='Enter') addTrack(); });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && R.playing && ytPlayer) {
      try { if (ytPlayer.getPlayerState() !== YT.PlayerState.PLAYING) ytPlayer.playVideo(); } catch(e){}
    }
  });

  autoRestore();
});

async function autoRestore() {
  const raw = sessionStorage.getItem(SESS);
  if (!raw) {
    const last = localStorage.getItem('sr_lasthost');
    if (last && localStorage.getItem(STORE + last)) {
      setStatus('이전 방이 있어요. <a href="#" onclick="restoreLast(event)" style="color:var(--accent);text-decoration:underline">복원하기</a>');
    }
    return;
  }
  const { roomCode, isHost } = JSON.parse(raw);
  if (isHost) {
    setStatus('방을 복원하는 중...');
    const saved = localStorage.getItem(STORE + roomCode);
    const data  = saved ? JSON.parse(saved) : null;
    try {
      await initPeer('syncroom-' + roomCode);
      R.roomCode = roomCode; R.isHost = true;
      R.tracks   = data?.tracks || []; R.curIdx = data?.curIdx ?? -1; R.playing = false;
      saveRoom(); saveSession(); enterRoom();
      showToast('🔄 방이 복원됐어요!'); setStatus('');
    } catch(e) {
      setStatus(''); sessionStorage.removeItem(SESS);
    }
  } else {
    R.roomCode = roomCode; R.isHost = false;
    setStatus('재연결 중...');
    guestReconnect(roomCode, 0);
  }
}

function restoreLast(e) {
  e.preventDefault();
  const code = localStorage.getItem('sr_lasthost'); if (!code) return;
  sessionStorage.setItem(SESS, JSON.stringify({ roomCode: code, isHost: true }));
  location.reload();
}
