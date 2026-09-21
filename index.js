// ==================== 1. 后端房间状态中枢 (Durable Object) ====================
export class ChessRoom {
  constructor() {
    this.sessions = new Map(); // session => { id, name, role: 0(观战)|1(黑)|2(白) }
    this.board = Array(15).fill(null).map(() => Array(15).fill(0));
    this.turn = 1; // 1: 黑方, 2: 白方
    this.winner = 0; // 0: 对局中, 1: 黑胜, 2: 白胜, 3: 平局
    this.lastMove = null;
    this.blackPlayer = null; // { id, name }
    this.whitePlayer = null; // { id, name }
    this.turnDeadline = 0;   // 倒计时截止时间戳
    this.drawProposer = null; // 发起求和的 role
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    server.accept();

    const playerId = crypto.randomUUID();
    // 默认进入房间均为观战者 (role = 0)
    this.sessions.set(server, { id: playerId, name: "神秘弈客", role: 0 });

    // 同步当前桌台全量数据
    server.send(JSON.stringify({
      type: "init",
      playerId,
      board: this.board,
      turn: this.turn,
      winner: this.winner,
      lastMove: this.lastMove,
      blackPlayer: this.blackPlayer,
      whitePlayer: this.whitePlayer,
      turnDeadline: this.turnDeadline,
      onlineCount: this.sessions.size
    }));

    server.addEventListener("message", event => {
      const data = JSON.parse(event.data);
      const user = this.sessions.get(server);
      if (!user) return;

      if (data.type === "join") {
        user.name = data.name;
        this.broadcastState();
        this.broadcastChat("系统", `${user.name} 进入了棋牌室。`);

      } else if (data.type === "rename") {
        const old = user.name;
        user.name = data.name;
        if (this.blackPlayer?.id === user.id) this.blackPlayer.name = user.name;
        if (this.whitePlayer?.id === user.id) this.whitePlayer.name = user.name;
        this.broadcastState();
        this.broadcastChat("系统", `[${old}] 更名为 [${user.name}]`);

      } else if (data.type === "take_seat") {
        // 自主选座逻辑
        const targetRole = data.role; // 1: 黑, 2: 白
        if (targetRole === 1 && !this.blackPlayer) {
          this.vacateSeat(user);
          user.role = 1;
          this.blackPlayer = { id: user.id, name: user.name };
          this.broadcastChat("系统", `${user.name} 坐上了 [黑方席位]`);
          this.checkGameStart();
        } else if (targetRole === 2 && !this.whitePlayer) {
          this.vacateSeat(user);
          user.role = 2;
          this.whitePlayer = { id: user.id, name: user.name };
          this.broadcastChat("系统", `${user.name} 坐上了 [白方席位]`);
          this.checkGameStart();
        }
        this.broadcastState();

      } else if (data.type === "leave_seat") {
        // 主动离席为观战者
        if (user.role !== 0) {
          this.broadcastChat("系统", `${user.name} 离开了对战席位。`);
          this.vacateSeat(user);
          this.resetGame();
          this.broadcastState();
        }

      } else if (data.type === "drop") {
        // 落子判断
        if (this.winner !== 0 || !this.isGameReady()) return;
        if (user.role !== this.turn) return;

        // 检查是否超时
        if (Date.now() > this.turnDeadline) {
          this.handleTimeoutWin(this.turn === 1 ? 2 : 1);
          return;
        }

        const { x, y } = data;
        if (x < 0 || x >= 15 || y < 0 || y >= 15 || this.board[y][x] !== 0) return;

        this.board[y][x] = this.turn;
        this.lastMove = { x, y };

        if (this.checkWin(x, y, this.turn)) {
          this.winner = this.turn;
          this.turnDeadline = 0;
          this.broadcastState();
          this.broadcastChat("系统", `对局结束！${this.winner === 1 ? "黑方" : "白方"} [${user.name}] 达成五子连珠，获得胜利！`);
        } else {
          this.turn = this.turn === 1 ? 2 : 1;
          this.turnDeadline = Date.now() + 30000; // 重置 30 秒倒计时
          this.broadcastState();
        }

      } else if (data.type === "resign") {
        // 认输
        if (user.role === 0 || this.winner !== 0 || !this.isGameReady()) return;
        this.winner = user.role === 1 ? 2 : 1;
        this.turnDeadline = 0;
        this.broadcastState();
        this.broadcastChat("系统", `${user.name} 选择了认输，${this.winner === 1 ? "黑方" : "白方"} 获胜！`);

      } else if (data.type === "propose_draw") {
        // 发起求和
        if (user.role === 0 || this.winner !== 0 || !this.isGameReady() || this.drawProposer) return;
        this.drawProposer = user.role;
        this.broadcast({ type: "draw_offer", fromName: user.name, fromRole: user.role });
        this.broadcastChat("系统", `${user.name} 提出了求和请求，等待对手确认...`);

      } else if (data.type === "respond_draw") {
        // 回应求和
        if (!this.drawProposer || user.role === this.drawProposer || user.role === 0) return;
        if (data.accept) {
          this.winner = 3; // 平局
          this.turnDeadline = 0;
          this.broadcastState();
          this.broadcastChat("系统", `双方同意求和，本局以平局握手言和！`);
        } else {
          this.broadcastChat("系统", `对手拒绝了求和请求，对局继续！`);
        }
        this.drawProposer = null;

      } else if (data.type === "check_timeout") {
        // 前端倒计时归零时校验
        if (this.winner === 0 && this.isGameReady() && this.turnDeadline > 0 && Date.now() >= this.turnDeadline) {
          this.handleTimeoutWin(this.turn === 1 ? 2 : 1);
        }

      } else if (data.type === "restart") {
        // 重新开局
        if (!this.isGameReady()) return;
        this.resetGame();
        this.turnDeadline = Date.now() + 30000;
        this.broadcastState();
        this.broadcastChat("系统", `${user.name} 重新初始化了棋局。`);

      } else if (data.type === "chat") {
        if (data.text?.trim()) {
          this.broadcastChat(user.name, data.text.trim());
        }
      }
    });

    server.addEventListener("close", () => {
      const user = this.sessions.get(server);
      this.sessions.delete(server);
      if (user) {
        if (user.role !== 0) {
          this.vacateSeat(user);
          this.resetGame();
        }
        this.broadcastChat("系统", `${user.name} 离开了房间。`);
        this.broadcastState();
      }
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  vacateSeat(user) {
    if (this.blackPlayer?.id === user.id) this.blackPlayer = null;
    if (this.whitePlayer?.id === user.id) this.whitePlayer = null;
    user.role = 0;
  }

  isGameReady() {
    return this.blackPlayer !== null && this.whitePlayer !== null;
  }

  checkGameStart() {
    if (this.isGameReady()) {
      this.resetGame();
      this.turnDeadline = Date.now() + 30000;
      this.broadcastChat("系统", `双方就绪，对局正式开始！黑方先手思考中（限时 30 秒）`);
    } else {
      this.turnDeadline = 0;
    }
  }

  resetGame() {
    this.board = Array(15).fill(null).map(() => Array(15).fill(0));
    this.turn = 1;
    this.winner = 0;
    this.lastMove = null;
    this.drawProposer = null;
  }

  handleTimeoutWin(winRole) {
    this.winner = winRole;
    this.turnDeadline = 0;
    this.broadcastState();
    this.broadcastChat("系统", `落子超时！${winRole === 1 ? "黑方" : "白方"} 超时获胜！`);
  }

  checkWin(x, y, color) {
    const directions = [[1, 0], [0, 1], [1, 1], [1, -1]];
    for (const [dx, dy] of directions) {
      let count = 1;
      for (let i = 1; i < 5; i++) {
        const nx = x + dx * i, ny = y + dy * i;
        if (nx >= 0 && nx < 15 && ny >= 0 && ny < 15 && this.board[ny][nx] === color) count++;
        else break;
      }
      for (let i = 1; i < 5; i++) {
        const nx = x - dx * i, ny = y - dy * i;
        if (nx >= 0 && nx < 15 && ny >= 0 && ny < 15 && this.board[ny][nx] === color) count++;
        else break;
      }
      if (count >= 5) return true;
    }
    return false;
  }

  broadcastState() {
    this.broadcast({
      type: "sync",
      board: this.board,
      turn: this.turn,
      winner: this.winner,
      lastMove: this.lastMove,
      blackPlayer: this.blackPlayer,
      whitePlayer: this.whitePlayer,
      turnDeadline: this.turnDeadline,
      onlineCount: this.sessions.size
    });
  }

  broadcast(data) {
    const msg = JSON.stringify(data);
    for (const session of this.sessions.keys()) {
      try { session.send(msg); } catch (e) { this.sessions.delete(session); }
    }
  }

  broadcastChat(sender, text) {
    this.broadcast({ type: "chat", sender, text });
  }
}

// ==================== 2. 前端单页界面 (HTML + CSS + JS) ====================
const HTML_CONTENT = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>五子棋棋牌大厅</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #22272e; color: #adbac7; display: flex; flex-direction: column; align-items: center; min-height: 100vh; padding: 12px; }
  
  header { width: 100%; max-width: 900px; display: flex; justify-content: space-between; align-items: center; background: #2d333b; padding: 12px 18px; border-radius: 8px; margin-bottom: 12px; gap: 10px; flex-wrap: wrap; }
  .user-group { display: flex; align-items: center; gap: 8px; }
  input[type="text"] { background: #1c2128; border: 1px solid #444c56; color: #cdd9e5; padding: 6px 10px; border-radius: 6px; outline: none; }
  button { background: #347d39; color: #fff; border: none; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-weight: 500; font-size: 13px; }
  button:hover { opacity: 0.9; }
  .btn-gray { background: #444c56; }
  .btn-danger { background: #cb2431; }
  .btn-warn { background: #b08800; }

  /* 席位与状态信息栏 */
  .match-bar { width: 100%; max-width: 900px; background: #2d333b; padding: 10px 18px; border-radius: 8px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; }
  .seat-box { display: flex; gap: 15px; align-items: center; }
  .seat-badge { display: flex; align-items: center; gap: 6px; font-size: 14px; background: #1c2128; padding: 6px 12px; border-radius: 6px; border: 1px solid #444c56; }
  .seat-dot { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
  .dot-black { background: #000; border: 1px solid #fff; }
  .dot-white { background: #fff; }

  .status-box { display: flex; align-items: center; gap: 12px; }
  .timer-tag { font-size: 15px; font-weight: bold; color: #f69d50; padding: 4px 10px; background: #1c2128; border-radius: 6px; }

  main { display: flex; gap: 15px; width: 100%; max-width: 900px; justify-content: center; flex-wrap: wrap; }
  
  /* 棋盘 */
  #board-area { background: #d6a84c; padding: 15px; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.4); display: flex; flex-direction: column; align-items: center; }
  canvas { cursor: pointer; }
  .action-buttons { margin-top: 12px; display: flex; gap: 10px; width: 100%; justify-content: center; }

  /* 聊天室 */
  .chat-panel { width: 320px; height: 530px; background: #2d333b; border-radius: 8px; display: flex; flex-direction: column; overflow: hidden; }
  .chat-title { padding: 10px 14px; background: #1c2128; font-size: 14px; font-weight: bold; border-bottom: 1px solid #444c56; display: flex; justify-content: space-between; }
  #chat-list { flex: 1; padding: 10px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
  .chat-row { line-height: 1.4; word-break: break-all; }
  .chat-row.sys { color: #f69d50; font-style: italic; }
  .chat-row .uname { color: #58a6ff; font-weight: bold; margin-right: 4px; }
  .chat-input-bar { padding: 10px; background: #1c2128; display: flex; gap: 6px; border-top: 1px solid #444c56; }
  .chat-input-bar input { flex: 1; }
</style>
</head>
<body>

<header>
  <div class="user-group">
    <span>我的昵称：</span>
    <input type="text" id="my-name" maxlength="8">
    <button onclick="changeName()">确定修改</button>
    <button class="btn-gray" onclick="randomName()">随机取名</button>
  </div>
  <div id="online-tag" style="font-size: 13px; color: #768390;">在线：1 人</div>
</header>

<div class="match-bar">
  <div class="seat-box">
    <div class="seat-badge">
      <span class="seat-dot dot-black"></span>
      <span id="black-name">黑方：等待入座</span>
      <button id="btn-seat-1" onclick="takeSeat(1)">坐下执黑</button>
    </div>
    <div class="seat-badge">
      <span class="seat-dot dot-white"></span>
      <span id="white-name">白方：等待入座</span>
      <button id="btn-seat-2" onclick="takeSeat(2)">坐下执白</button>
    </div>
    <button id="btn-leave" class="btn-gray" onclick="leaveSeat()" style="display:none;">下座观战</button>
  </div>

  <div class="status-box">
    <div id="turn-info" style="font-weight:bold;">等待玩家入座</div>
    <div id="timer-info" class="timer-tag" style="display:none;">30 秒</div>
  </div>
</div>

<main>
  <div id="board-area">
    <canvas id="chess" width="480" height="480"></canvas>
    <div class="action-buttons">
      <button class="btn-warn" id="btn-draw" onclick="proposeDraw()" disabled>求和</button>
      <button class="btn-danger" id="btn-resign" onclick="resignGame()" disabled>认输</button>
      <button class="btn-gray" id="btn-restart" onclick="restartGame()" disabled>重开一局</button>
    </div>
  </div>

  <div class="chat-panel">
    <div class="chat-title">
      <span>房间对话</span>
      <span id="my-role-text" style="color:#58a6ff;">观战中</span>
    </div>
    <div id="chat-list"></div>
    <div class="chat-input-bar">
      <input type="text" id="chat-text" placeholder="按 Enter 发送消息..." maxlength="100">
      <button onclick="sendChat()">发送</button>
    </div>
  </div>
</main>

<script>
  // 随机中文名字生成器
  const prefixes = ["悠然的", "淡定的", "睿智的", "从容的", "深思的", "纵横的", "隐修的", "策马的", "弈海的", "问道的"];
  const suffixes = ["棋圣", "国手", "弈者", "隐士", "居士", "先锋", "书生", "游侠", "名宿", "布衣"];
  function getRandomName() {
    return prefixes[Math.floor(Math.random() * prefixes.length)] + suffixes[Math.floor(Math.random() * suffixes.length)];
  }

  let ws, myId = null, myRole = 0; // 0: 观战, 1: 黑, 2: 白
  let boardState = Array(15).fill(null).map(() => Array(15).fill(0));
  let currentTurn = 1, winner = 0, lastMove = null, turnDeadline = 0;
  let blackPlayer = null, whitePlayer = null;

  const canvas = document.getElementById("chess");
  const ctx = canvas.getContext("2d");
  const CELL = 30, PAD = 30;

  const nameInput = document.getElementById("my-name");
  let myName = localStorage.getItem("chess_name") || getRandomName();
  nameInput.value = myName;

  function connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(\`\${proto}//\${location.host}\`);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "join", name: myName }));
    };

    ws.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === "init") {
        myId = data.playerId;
        applySync(data);
      } else if (data.type === "sync") {
        applySync(data);
      } else if (data.type === "draw_offer") {
        if (myRole !== 0 && myRole !== data.fromRole) {
          const agree = confirm(\`对手 [\${data.fromName}] 向你提出求和，是否同意握手言和？\`);
          ws.send(JSON.stringify({ type: "respond_draw", accept: agree }));
        }
      } else if (data.type === "chat") {
        appendChat(data.sender, data.text);
      }
    };
  }

  function applySync(data) {
    boardState = data.board;
    currentTurn = data.turn;
    winner = data.winner;
    lastMove = data.lastMove;
    blackPlayer = data.blackPlayer;
    whitePlayer = data.whitePlayer;
    turnDeadline = data.turnDeadline;

    // 确定自己的身份
    if (blackPlayer && blackPlayer.id === myId) myRole = 1;
    else if (whitePlayer && whitePlayer.id === myId) myRole = 2;
    else myRole = 0;

    document.getElementById("online-tag").innerText = \`在线：\${data.onlineCount} 人\`;
    updateUI();
    drawBoard();
  }

  function updateUI() {
    // 席位渲染
    document.getElementById("black-name").innerText = blackPlayer ? \`黑方：\${blackPlayer.name}\` : "黑方：等待入座";
    document.getElementById("white-name").innerText = whitePlayer ? \`白方：\${whitePlayer.name}\` : "白方：等待入座";
    
    document.getElementById("btn-seat-1").style.display = (!blackPlayer && myRole === 0) ? "inline-block" : "none";
    document.getElementById("btn-seat-2").style.display = (!whitePlayer && myRole === 0) ? "inline-block" : "none";
    document.getElementById("btn-leave").style.display = (myRole !== 0) ? "inline-block" : "none";

    // 身份标识
    const roleTexts = ["观战中", "执黑 (先手)", "执白 (后手)"];
    document.getElementById("my-role-text").innerText = roleTexts[myRole];

    // 局况与按钮控制
    const ready = blackPlayer && whitePlayer;
    document.getElementById("btn-draw").disabled = !ready || myRole === 0 || winner !== 0;
    document.getElementById("btn-resign").disabled = !ready || myRole === 0 || winner !== 0;
    document.getElementById("btn-restart").disabled = !ready || myRole === 0;

    const turnInfo = document.getElementById("turn-info");
    if (!ready) {
      turnInfo.innerText = "等待双方入座...";
      document.getElementById("timer-info").style.display = "none";
    } else if (winner !== 0) {
      turnInfo.innerText = winner === 1 ? "黑方胜出！" : (winner === 2 ? "白方胜出！" : "对局平局！");
      document.getElementById("timer-info").style.display = "none";
    } else {
      turnInfo.innerText = currentTurn === 1 ? "轮到 黑方 走子" : "轮到 白方 走子";
      document.getElementById("timer-info").style.display = "block";
    }
  }

  // 30秒倒计时主循环
  setInterval(() => {
    if (turnDeadline > 0 && winner === 0 && blackPlayer && whitePlayer) {
      const remaining = Math.max(0, Math.ceil((turnDeadline - Date.now()) / 1000));
      const timerEl = document.getElementById("timer-info");
      timerEl.innerText = \`\${remaining} 秒\`;
      
      if (remaining <= 5) {
        timerEl.style.color = "#cb2431"; // 最后5秒变红警示
      } else {
        timerEl.style.color = "#f69d50";
      }

      // 超时判定
      if (remaining === 0 && myRole === currentTurn) {
        ws.send(JSON.stringify({ type: "check_timeout" }));
      }
    }
  }, 500);

  // 棋盘 Canvas 渲染
  function drawBoard() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = "#4a3c28";
    ctx.lineWidth = 1;
    for (let i = 0; i < 15; i++) {
      ctx.beginPath();
      ctx.moveTo(PAD, PAD + i * CELL);
      ctx.lineTo(PAD + 14 * CELL, PAD + i * CELL);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(PAD + i * CELL, PAD);
      ctx.lineTo(PAD + i * CELL, PAD + 14 * CELL);
      ctx.stroke();
    }

    const stars = [[3, 3], [11, 3], [7, 7], [3, 11], [11, 11]];
    for (const [sx, sy] of stars) {
      ctx.beginPath();
      ctx.arc(PAD + sx * CELL, PAD + sy * CELL, 3, 0, 2 * Math.PI);
      ctx.fillStyle = "#4a3c28";
      ctx.fill();
    }

    for (let y = 0; y < 15; y++) {
      for (let x = 0; x < 15; x++) {
        if (boardState[y][x] !== 0) drawPiece(x, y, boardState[y][x]);
      }
    }

    if (lastMove) {
      ctx.fillStyle = "#cb2431";
      ctx.beginPath();
      ctx.arc(PAD + lastMove.x * CELL, PAD + lastMove.y * CELL, 4, 0, 2 * Math.PI);
      ctx.fill();
    }
  }

  function drawPiece(x, y, color) {
    const cx = PAD + x * CELL, cy = PAD + y * CELL;
    ctx.beginPath();
    ctx.arc(cx, cy, 13, 0, 2 * Math.PI);
    const grad = ctx.createRadialGradient(cx - 3, cy - 3, 1, cx, cy, 13);
    if (color === 1) {
      grad.addColorStop(0, "#57606f"); grad.addColorStop(1, "#000000");
    } else {
      grad.addColorStop(0, "#ffffff"); grad.addColorStop(1, "#dcdde1");
    }
    ctx.fillStyle = grad;
    ctx.fill();
  }

  canvas.addEventListener("click", (e) => {
    if (winner !== 0 || myRole !== currentTurn || !blackPlayer || !whitePlayer) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const x = Math.round((px - PAD) / CELL);
    const y = Math.round((py - PAD) / CELL);

    if (x >= 0 && x < 15 && y >= 0 && y < 15 && boardState[y][x] === 0) {
      ws.send(JSON.stringify({ type: "drop", x, y }));
    }
  });

  // 操作派发
  function takeSeat(role) { ws.send(JSON.stringify({ type: "take_seat", role })); }
  function leaveSeat() { ws.send(JSON.stringify({ type: "leave_seat" })); }
  function resignGame() { if (confirm("确定要认输吗？")) ws.send(JSON.stringify({ type: "resign" })); }
  function proposeDraw() { ws.send(JSON.stringify({ type: "propose_draw" })); }
  function restartGame() { if (confirm("重新清空棋盘开局？")) ws.send(JSON.stringify({ type: "restart" })); }

  function changeName() {
    const val = nameInput.value.trim();
    if (!val) return;
    myName = val;
    localStorage.setItem("chess_name", myName);
    ws.send(JSON.stringify({ type: "rename", name: myName }));
  }

  function randomName() {
    nameInput.value = getRandomName();
    changeName();
  }

  function sendChat() {
    const input = document.getElementById("chat-text");
    const text = input.value.trim();
    if (!text) return;
    ws.send(JSON.stringify({ type: "chat", text }));
    input.value = "";
  }

  document.getElementById("chat-text").addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendChat();
  });

  function appendChat(sender, text) {
    const list = document.getElementById("chat-list");
    const row = document.createElement("div");
    row.className = "chat-row" + (sender === "系统" ? " sys" : "");
    row.innerHTML = sender === "系统" ? \`[系统] \${text}\` : \`<span class="uname">\${sender}:</span><span>\${text}</span>\`;
    list.appendChild(row);
    list.scrollTop = list.scrollHeight;
  }

  connect();
</script>
</body>
</html>`;

// ==================== 3. Cloudflare Worker 请求入口 ====================
export default {
  async fetch(request, env) {
    if (request.headers.get("Upgrade") === "websocket") {
      const id = env.CHESS_ROOM.idFromName("public_lobby");
      return env.CHESS_ROOM.get(id).fetch(request);
    }
    return new Response(HTML_CONTENT, {
      headers: { "Content-Type": "text/html; charset=UTF-8" }
    });
  }
};
