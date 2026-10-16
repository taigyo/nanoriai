import { generateTheme, generateCard, generateBattle } from './ai.js';

const STARS_TO_WIN = 3;
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);

/*
 * 対戦部屋（Durable Object）。状態はメモリ上のみ
 *
 * phase: lobby(相手待ち) → theming(テーマ生成中) → naming(カード名入力)
 *        → judging(両者のカード生成中)
 *        → reveal(カード公開。読んでいる間にバトル生成。生成後「バトル開始」)
 *        → playing(両者が押した → ログ配信) → theming … → finished(3★)
 *
 * クライアント→サーバー
 *   {type:'join', pid, name} / {type:'submit', cardName} / {type:'start'} / {type:'rematch'}
 * サーバー→クライアント
 *   {type:'state', phase, turn, theme, starsToWin, battleReady, cards(revealのみ),
 *     me:{name,stars,submitted,started,rematch}, opponent:{...,connected}|null, youWonGame}
 *   {type:'result', turn, theme, me, opponent, log:[{side:'me'|'opp'|'n', text}], youWon, stars, gameOver}
 *   {type:'error', message, code?} / {type:'replaced'}
 */
export class Room {
  constructor(state, env) {
    this.env = env;
    this.players = [];
    this.phase = 'lobby';
    this.turn = 0;
    this.theme = null;
    this.pastThemes = [];
    this.battling = false;
    this.battleReady = false;
    this.pending = null;
    this.gameWinner = null;
  }

  async fetch() {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    server.addEventListener('message', (e) => this.onMessage(server, e.data));
    server.addEventListener('close', () => this.onClose(server));
    server.addEventListener('error', () => this.onClose(server));
    return new Response(null, { status: 101, webSocket: client });
  }

  send(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch {}
  }

  async onMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try {
      if (msg.type === 'join') return await this.join(ws, msg);
      const p = this.players.find((x) => x.ws === ws);
      if (!p) return;
      if (msg.type === 'submit') return await this.submit(p, msg.cardName);
      if (msg.type === 'start') return await this.start(p);
      if (msg.type === 'rematch') return await this.rematch(p);
    } catch (err) {
      console.error(err);
      this.send(ws, { type: 'error', message: 'サーバーでエラーが起きました' });
    }
  }

  onClose(ws) {
    const p = this.players.find((x) => x.ws === ws);
    if (!p) return;
    p.ws = null;
    if (this.phase === 'lobby') this.players = this.players.filter((x) => x !== p);
    this.broadcastState();
  }

  async join(ws, msg) {
    const pid = clean(msg.pid, 64);
    const name = clean(msg.name, 12) || 'ななしさん';
    if (!pid) return;
    let p = this.players.find((x) => x.pid === pid);
    if (p) {
      const old = p.ws;
      p.ws = ws;
      p.name = name;
      if (old && old !== ws) {
        this.send(old, { type: 'replaced' }); // 古い接続には再接続させない
        try { old.close(); } catch {}
      }
    } else {
      if (this.players.length >= 2) {
        return this.send(ws, { type: 'error', code: 'full', message: 'この場は満員です' });
      }
      p = { pid, name, ws, stars: 0, cardName: null, card: null, cardPromise: null, started: false, rematch: false };
      this.players.push(p);
    }
    this.broadcastState();
    if (this.players.length === 2 && this.phase === 'lobby') await this.startTurn();
  }

  stateFor(p) {
    const o = this.players.find((x) => x !== p);
    const reveal = this.phase === 'reveal' && o;
    return {
      type: 'state',
      phase: this.phase,
      turn: this.turn,
      theme: this.theme,
      starsToWin: STARS_TO_WIN,
      battleReady: this.battleReady,
      cards: reveal
        ? { me: { cardName: p.cardName, card: p.card }, opponent: { cardName: o.cardName, card: o.card } }
        : null,
      me: { name: p.name, stars: p.stars, submitted: !!p.cardName, started: p.started, rematch: p.rematch },
      opponent: o
        ? { name: o.name, stars: o.stars, submitted: !!o.cardName, rematch: o.rematch, connected: !!o.ws }
        : null,
      youWonGame: this.phase === 'finished' ? this.gameWinner === p : null,
    };
  }

  broadcastState() {
    for (const p of this.players) if (p.ws) this.send(p.ws, this.stateFor(p));
  }

  // ① ターン開始：バトルテーマ生成
  async startTurn() {
    this.turn++;
    this.phase = 'theming';
    this.battling = false;
    this.battleReady = false;
    this.pending = null;
    for (const p of this.players) { p.cardName = null; p.card = null; p.cardPromise = null; p.started = false; }
    this.broadcastState();
    this.theme = await generateTheme(this.env, this.pastThemes);
    this.pastThemes.push(this.theme);
    if (this.pastThemes.length > 8) this.pastThemes.shift();
    this.phase = 'naming';
    this.broadcastState();
  }

  // ② カード名が決まった瞬間に、そのプレイヤーのカード生成を開始
  async submit(p, rawName) {
    if (this.phase !== 'naming' || p.cardName) return;
    const name = clean(rawName, 20);
    if (!name) return this.send(p.ws, { type: 'error', message: '名乗りを入力してください' });
    p.cardName = name;
    p.cardPromise = generateCard(this.env, name, this.theme); // 内部でcatch済み
    this.broadcastState();
    if (this.players.length === 2 && this.players.every((x) => x.cardName)) await this.prepareBattle();
  }

  // 両者のカードが揃ったら公開し、読んでもらっている間にバトルを生成しておく
  async prepareBattle() {
    if (this.battling) return;
    this.battling = true;
    this.phase = 'judging';
    this.broadcastState();

    const [a, b] = this.players;
    [a.card, b.card] = await Promise.all([a.cardPromise, b.cardPromise]);
    this.phase = 'reveal';
    this.battleReady = false;
    this.broadcastState(); // カード公開

    // AとBの割り当てはランダム（位置バイアス対策）
    const swap = Math.random() < 0.5;
    const first = swap ? b : a;
    const second = swap ? a : b;
    const res = await generateBattle(
      this.env,
      this.theme,
      { name: first.cardName, ...first.card },
      { name: second.cardName, ...second.card },
    );
    this.pending = { res, first, second };
    this.battleReady = true;
    this.broadcastState(); // 「バトル開始」ボタンを出す
  }

  // 「バトル開始」ボタン。両者が押したら同時にログを配信
  async start(p) {
    if (this.phase !== 'reveal' || !this.battleReady || p.started) return;
    p.started = true;
    this.broadcastState();
    if (this.players.length === 2 && this.players.every((x) => x.started)) await this.play();
  }

  async play() {
    this.phase = 'playing';
    const { res, first, second } = this.pending;
    const winner = res.winner === 'A' ? first : second;
    winner.stars++;
    const gameOver = winner.stars >= STARS_TO_WIN;
    if (gameOver) this.gameWinner = winner;

    for (const p of this.players) {
      if (!p.ws) continue;
      const o = this.players.find((x) => x !== p);
      const log = res.log.map((l) => ({
        side: l.who === 'N' ? 'n' : (l.who === 'A' ? first : second) === p ? 'me' : 'opp',
        text: l.text,
      }));
      this.send(p.ws, {
        type: 'result',
        turn: this.turn,
        theme: this.theme,
        me: { cardName: p.cardName, card: p.card },
        opponent: { cardName: o.cardName, card: o.card },
        log,
        youWon: winner === p,
        stars: { me: p.stars, opponent: o.stars },
        gameOver,
      });
    }

    if (gameOver) {
      this.phase = 'finished';
      this.broadcastState();
    } else {
      await this.startTurn(); // 結果確定直後に次のテーマを生成
    }
  }

  async rematch(p) {
    if (this.phase !== 'finished') return;
    p.rematch = true;
    if (this.players.length === 2 && this.players.every((x) => x.rematch)) {
      for (const x of this.players) { x.stars = 0; x.rematch = false; }
      this.turn = 0;
      this.pastThemes = [];
      this.gameWinner = null;
      await this.startTurn();
    } else {
      this.broadcastState();
    }
  }
}
