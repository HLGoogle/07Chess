// ==================== 1. 房间状态机 (Durable Object) ====================
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
    this.drawProposer = null; // 发起求和者的 role
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    server.accept();

    const playerId = crypto.randomUUID();
    this.sessions.set(server, { id: playerId, name: "神秘弈客", role: 0 });

    // 同步初态
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
        if (user.role !== 0) {
          this.broadcastChat("系统", `${user.name} 离开了对局席位。`);
          this.vacateSeat(user);
          this.resetGame();
          this.broadcastState();
        }

      } else if (data.type === "drop") {
        if (this.winner !== 0 || !this.isGameReady()) return;
        if (user.role !== this.turn) return;

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
          this.broadcastChat("系统", `对局结束！${this.winner === 1 ? "黑方" : "白方"} [${user.name}] 达成五连珠，获得胜利！`);
        } else {
          this.turn = this.turn === 1 ? 2 : 1;
          this.turnDeadline = Date.now() + 30000;
          this.broadcastState();
        }

      } else if (data.type === "resign") {
        if (user.role === 0 || this.winner !== 0 || !this.isGameReady()) return;
        this.winner = user.role === 1 ? 2 : 1;
        this.turnDeadline = 0;
        this.broadcastState();
        this.broadcastChat("系统", `${user.name} 选择了认输，${this.winner === 1 ? "黑方" : "白方"} 获胜！`);

      } else if (data.type === "propose_draw") {
        if (user.role === 0 || this.winner !== 0 || !this.isGameReady() || this.drawProposer) return;
        this.drawProposer = user.role;
        this.broadcast({ type: "draw_offer", fromName: user.name, fromRole: user.role });
        this.broadcastChat("系统", `${user.name} 提出了求和请求，等待对方回应...`);

      } else if (data.type === "respond_draw") {
        if (!this.drawProposer || user.role === this.drawProposer || user.role === 0) return;
        if (data.accept) {
          this.winner = 3;
          this.turnDeadline = 0;
          this.broadcastState();
          this.broadcastChat("系统", `双方同意求和，本局以平局结束！`);
        } else {
          this.broadcastChat("系统", `对手拒绝了求和请求，对局继续！`);
        }
        this.drawProposer = null;

      } else if (data.type === "check_timeout") {
        if (this.winner === 0 && this.isGameReady() && this.turnDeadline > 0 && Date.now() >= this.turnDeadline) {
          this.handleTimeoutWin(this.turn === 1 ? 2 : 1);
        }

      } else if (data.type === "restart") {
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
      this.broadcastChat("系统", `双方就绪，对局开始！黑方先手（30秒限时）`);
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
    this.broadcastChat("系统", `思考超时！${winRole === 1 ? "黑方" : "白方"} 超时获胜！`);
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

// ==================== 2. Worker 路由入口 ====================
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
        }
      });
    }

    if (request.headers.get("Upgrade") === "websocket") {
      const id = env.CHESS_ROOM.idFromName("gomoku_public_room");
      return env.CHESS_ROOM.get(id).fetch(request);
    }

    return new Response("07Chess 联机网关已运行。请通过 WebSocket 连接或在前端访问。", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=UTF-8" }
    });
  }
};
